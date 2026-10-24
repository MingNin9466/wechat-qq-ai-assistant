/**
 * 入口：装配依赖 → 连微信 → 跑调度器。
 *
 * 用法：
 *   node src/main.ts            # 连真实微信（需要微信 3.9.12.17 已登录）
 *   node src/main.ts --mock     # 本地模拟，不连微信
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { config, ensureDirs, ROOT, validateConfig } from './config.ts';
import { MockAdapter } from './adapters/mock.ts';
import { WcfAdapter } from './adapters/wcf.ts';
import { WxautoAdapter } from './adapters/wxauto.ts';
import { startAdmin } from './admin/server.ts';
import type { WeChatAdapter } from './adapters/types.ts';
import { Dispatcher } from './core/dispatcher.ts';
import { getSetting } from './core/settings.ts';
import { backupNow, closeDb, getDb, healthCheck, openDb, pruneBackups } from './infra/db.ts';
import { extractMemories, makeDiary } from './memory/distill.ts';
import { browseOnce, dueForBrowse } from './integrations/learn.ts';
import { attachLogSink, configureLogger, createLogger } from './infra/logger.ts';
import { addLogRow } from './memory/store.ts';
import { beijingDate, beijingParts, sleep } from './util.ts';

const log = createLogger('main');

let stopping = false;

import { createConnection } from 'node:net';

/** 端口是否已被监听（用来做单实例保护） */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1500, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // 单实例保护：端口已被占用说明已有机器人在跑，直接退出。
  // 否则两个实例会同时消费同一个桥接的消息，导致"一条消息回两次"。
  const guardPort = Number(process.env.ADMIN_PORT ?? 8898);
  if (await portInUse(guardPort)) {
    console.error(
      `[退出] 端口 ${guardPort} 已被占用：已经有一个机器人在运行了。\n` +
        '       两个实例会重复回复，所以这里主动退出。\n' +
        '       要重启请先运行「一键重启.cmd」。',
    );
    process.exit(0);
  }

  // 接入方式：--adapter=wxauto|wcf|mock，或环境变量 ADAPTER；--mock/--demo 等价于 mock
  const adapterKind = (
    argv.find((a) => a.startsWith('--adapter='))?.split('=')[1] ??
    process.env.ADAPTER ??
    (argv.includes('--mock') || argv.includes('--demo') ? 'mock' : 'wcf')
  ).toLowerCase();
  const useMock = adapterKind === 'mock';

  ensureDirs();
  configureLogger({ level: config.log.level, pretty: config.env !== 'production' });
  openDb();
  if (config.log.db) attachLogSink(addLogRow);

  const health = healthCheck();
  log.info('数据库已就绪', {
    tables: health.tables.length,
    version: health.userVersion,
    integrity: health.integrity,
    wal: `${Math.round(health.walSizeBytes / 1024)}KB`,
  });
  if (!health.ok) {
    log.error('数据库完整性检查未通过，请先备份后排查', { integrity: health.integrity });
  }

  const problems = validateConfig();
  for (const p of problems) log.warn(`配置问题：${p}`);

  const adapter: WeChatAdapter =
    adapterKind === 'wxauto' ? new WxautoAdapter() : adapterKind === 'mock' ? new MockAdapter() : new WcfAdapter();
  log.info('接入方式', { adapter: adapterKind });
  const dispatcher = new Dispatcher(adapter);
  dispatcher.start();

  // QQ（OneBot 11）：--qq 或 QQ_ENABLED=1 时一起挂上，消息进同一套记忆与人格
  const useQQ = argv.includes('--qq') || process.env.QQ_ENABLED === '1';
  if (useQQ) {
    try {
      const { OneBotAdapter } = await import('./adapters/onebot.ts');
      const qq = new OneBotAdapter();
      await qq.connect();
      dispatcher.attachAdapter('qq:', qq);
      log.info('QQ 已接入', { listen: process.env.QQ_LISTEN_PORT ?? 8901, api: process.env.QQ_API_BASE ?? 'http://127.0.0.1:3000' });
    } catch (err) {
      log.error('QQ 接入失败（QQ 功能不可用，微信不受影响）', { err: (err as Error).message });
    }
  }

  adapter.onEvent(async (ev) => {
    if (ev.type === 'login') {
      log.info('机器人就绪', { name: ev.name, wxid: ev.wxid });
    } else if (ev.type === 'logout') {
      log.warn('微信掉线，准备重连', { reason: ev.reason });
      if (!stopping) void restart(adapter, 1);
    } else if (ev.type === 'error') {
      log.error('适配器错误', { err: ev.error.message });
    }
  });

  try {
    await adapter.connect();
  } catch (err) {
    log.error('连接微信失败', { err: (err as Error).message });
    if (useMock) throw err;
    log.warn('10 秒后重试一次；如果一直失败，请检查微信版本与登录状态');
    await sleep(10_000);
    await adapter.connect();
  }

  if (useMock && adapter instanceof MockAdapter) {
    await adapter.runConsole();
    await shutdown(0);
    return;
  }

  // 管理后台（默认 http://127.0.0.1:8898）
  const adminPort = Number(process.env.ADMIN_PORT ?? 8898);
  startAdmin({ dispatcher, adapter, port: adminPort });
  log.info('管理后台', { url: `http://127.0.0.1:${adminPort}` });

  // 定时维护：每天 03:10 备份，23:30 写日记
  let lastBackupDate = '';
  let lastDiaryDate = '';
  setInterval(() => {
    const p = beijingParts();

    if (p.time === '23:30' && lastDiaryDate !== p.date) {
      lastDiaryDate = p.date;
      try {
        const db = getDb();
        const rows = db
          .prepare('SELECT DISTINCT chat_id AS c FROM messages WHERE ts >= ?')
          .all(Date.now() - 86400_000) as { c: string }[];
        for (const r of rows) {
          void makeDiary(r.c, p.date).then((res) => {
            if (res.ok) log.info('日记生成', { chat: r.c, date: p.date });
          });
        }
      } catch (err) {
        log.error('日记任务失败', { err: (err as Error).message });
      }
    }

    if (p.time === '03:10' && lastBackupDate !== p.date) {
      lastBackupDate = p.date;
      try {
        const file = backupNow('daily');
        const removed = pruneBackups(30);
        log.info('每日备份完成', { file, removed });
      } catch (err) {
        log.error('每日备份失败', { err: (err as Error).message });
      }
    }
    if (p.time === '04:00') {
      const h = healthCheck();
      if (!h.ok) log.error('健康检查异常', { integrity: h.integrity });
    }

    // 每天 22:10 同步养鱼插件的日记到「待确认」队列
    if (p.time === '22:10') {
      try {
        const child = spawn(process.execPath, [join(ROOT, 'src', 'cli', 'sync-whale.ts')], {
          cwd: ROOT,
          windowsHide: true,
          stdio: 'ignore',
        });
        child.on('exit', (code) => log.info('养鱼日记同步结束', { code }));
      } catch (err) {
        log.debug('养鱼日记同步触发失败（忽略）', { err: (err as Error).message });
      }
    }

    // 定期提炼关键信息：每小时把所有活跃会话的摘要再提炼一次，写进记忆
    if (p.minute === 35 && (() => { try { return getSetting<boolean>('autoExtract'); } catch { return true; } })()) {
      try {
        const db = getDb();
        const rows = db
          .prepare("SELECT DISTINCT chat_id AS c FROM messages WHERE ts >= ?")
          .all(Date.now() - 3 * 86400_000) as { c: string }[];
        for (const r of rows) {
          void extractMemories(r.c, { limit: 6 }).then((res) => {
            if (res.ok && res.added > 0) log.info('定期提炼完成', { chat: r.c, added: res.added });
          });
        }
      } catch (err) {
        log.debug('定期提炼触发失败（忽略）', { err: (err as Error).message });
      }
    }

    // 自主学习：每 3 小时刷一个 B 站视频，学点"人类"的东西
    if (p.minute === 17 && dueForBrowse(3)) {
      try {
        const db = getDb();
        const row = db
          .prepare('SELECT chat_id AS c FROM messages ORDER BY ts DESC LIMIT 1')
          .get() as { c?: string } | undefined;
        const target = row?.c;
        if (target) {
          void browseOnce(target).then((res) => {
            if (res.ok) log.info('自主学习', { chat: target, title: res.title?.slice(0, 30) });
          });
        }
      } catch (err) {
        log.debug('自主学习触发失败（忽略）', { err: (err as Error).message });
      }
    }
  }, 60_000).unref();

  log.info('运行中，按 Ctrl+C 停止', { date: beijingDate(), mode: useMock ? 'mock' : 'wcf' });

  const stop = () => void shutdown(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.fatal('未捕获异常', { err: err.message, stack: err.stack?.slice(0, 800) });
  });
}

/** 掉线重连：最多 5 次，指数退避；连续失败就停下等人来看 */
async function restart(adapter: WeChatAdapter, attempt: number): Promise<void> {
  if (stopping) return;
  if (attempt > 5) {
    log.error('连续重连失败，停止重试。请人工检查微信是否被限制登录。');
    return;
  }
  const wait = Math.min(60_000, 5000 * attempt);
  log.info(`第 ${attempt} 次重连，${wait / 1000}s 后开始`);
  await sleep(wait);
  try {
    await adapter.disconnect();
    await adapter.connect();
    log.info('重连成功');
  } catch (err) {
    log.warn('重连失败', { attempt, err: (err as Error).message });
    await restart(adapter, attempt + 1);
  }
}

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('正在退出…');
  try {
    const file = backupNow('shutdown');
    log.info('退出前备份完成', { file });
  } catch (err) {
    log.warn('退出前备份失败', { err: (err as Error).message });
  }
  closeDb();
  process.exit(code);
}

void main();
