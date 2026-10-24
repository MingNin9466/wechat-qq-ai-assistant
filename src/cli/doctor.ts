/**
 * 环境体检：`npm run doctor`
 * 只做只读检查，不改任何东西。全程不 spawn 子进程（沙箱下会 EPERM）。
 */
import { existsSync, readdirSync, statSync, accessSync, constants, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { config, ensureDirs, validateConfig, ROOT } from '../config.ts';
import { closeDb, healthCheck, openDb } from '../infra/db.ts';
import { ping } from '../llm/client.ts';

interface Check {
  name: string;
  ok: boolean;
  level: 'fatal' | 'warn' | 'info';
  detail: string;
  fix?: string;
}

const checks: Check[] = [];

function add(name: string, ok: boolean, detail: string, level: Check['level'] = 'fatal', fix?: string): void {
  checks.push({ name, ok, detail, level, fix });
}

/**
 * 扫描常见安装目录，找微信版本。
 * 微信的目录结构不统一，实测见过两种：
 *   D:\WeChatBot\WeChat\[3.9.12.17]\WeChat.exe       （安装时选了目录，多一层 WeChat）
 *   C:\Program Files (x86)\Tencent\WeChat\[3.9.12.17]\
 * 所以用「限深递归 + 版本号目录名」判断，最多往下 3 层。
 */
function detectWeChat(): { dir: string; version: string }[] {
  const roots = [
    'C:\\Program Files\\Tencent\\WeChat',
    'C:\\Program Files (x86)\\Tencent\\WeChat',
    'D:\\Program Files\\Tencent\\WeChat',
    'D:\\Tencent\\WeChat',
    'E:\\Tencent\\WeChat',
    'E:\\Weixin',
    'D:\\Weixin',
    'C:\\Program Files\\Tencent\\Weixin',
    // 允许用户自定义（.env 里的 WECHAT_PATHS）
    ...config.wechat.paths,
  ];

  const results: { dir: string; version: string }[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || seen.has(dir)) return;
    seen.add(dir);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      const m = entry.name.match(/^\[?(\d+\.\d+\.\d+\.\d+)\]?$/);
      if (m?.[1]) {
        results.push({ dir, version: m[1] });
        continue;
      }
      // 只往看起来相关的子目录里钻，避免扫全盘
      if (/^(WeChat|Weixin|Tencent|WeChatBot|App)$/i.test(entry.name)) {
        walk(full, depth + 1);
      }
    }
  };

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const m = root.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (m?.[1]) {
      results.push({ dir: root.replace(/[\\/][^\\/]+$/, ''), version: m[1] });
      continue;
    }
    walk(root, 0);
  }

  // 去重
  const uniq = new Map<string, { dir: string; version: string }>();
  for (const r of results) uniq.set(`${r.dir}|${r.version}`, r);
  return [...uniq.values()];
}

function checkFfmpeg(): string | null {
  const candidates = [
    join(ROOT, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    join(ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'D:\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // PATH 里的 ffmpeg（不 spawn，只看常见位置）
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir) continue;
    const p = join(dir, 'ffmpeg.exe');
    if (existsSync(p)) return p;
  }
  return null;
}

async function main(): Promise<void> {
  const offline = process.argv.includes('--offline');

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  add(
    'Node.js 版本',
    major >= 22,
    `v${process.versions.node}${major >= 22 ? '' : '（需要 >= 22，推荐 24）'}`,
    major >= 22 ? 'info' : 'fatal',
    '到 nodejs.org 装 Node 24 LTS',
  );

  // 2. 目录可写
  try {
    ensureDirs();
    accessSync(config.storage.dataDir, constants.W_OK);
    add('数据目录可写', true, config.storage.dataDir, 'info');
  } catch (err) {
    add('数据目录可写', false, (err as Error).message, 'fatal', '检查 DSH 沙箱策略或目录权限');
  }

  // 3. 数据库
  try {
    openDb();
    const h = healthCheck();
    add(
      'SQLite',
      h.ok,
      `v${h.userVersion}，${h.tables.length} 张表，${(h.dbSizeBytes / 1024).toFixed(0)}KB，完整性 ${h.integrity}`,
      h.ok ? 'info' : 'fatal',
    );
  } catch (err) {
    add('SQLite', false, (err as Error).message, 'fatal');
  }

  // 4. 配置
  const problems = validateConfig();
  add('配置校验', problems.length === 0, problems.length ? problems.join('；') : '通过', problems.length ? 'warn' : 'info');

  // 5. API Key
  add(
    'DeepSeek API Key',
    Boolean(config.deepseek.apiKey),
    config.deepseek.apiKey ? `已配置（${config.deepseek.apiKey.slice(0, 6)}…）` : '未配置',
    config.deepseek.apiKey ? 'info' : 'fatal',
    '在 .env 里填 DEEPSEEK_API_KEY，去 platform.deepseek.com 申请',
  );

  // 6. 联网连通性
  if (config.deepseek.apiKey && !offline) {
    const r = await ping();
    add(
      'DeepSeek 连通性',
      r.ok,
      r.ok ? `正常（${r.ms}ms，回复「${r.detail}」）` : r.detail,
      r.ok ? 'info' : 'warn',
      r.ok ? undefined : '检查网络 / 代理 / 余额',
    );
  } else {
    add('DeepSeek 连通性', true, offline ? '已跳过（--offline）' : '跳过（无 Key）', 'info');
  }

  // 7. 微信依赖
  try {
    await import('@wechatferry/agent');
    add('WechatFerry 依赖', true, '@wechatferry/agent 可加载', 'info');
  } catch (err) {
    add('WechatFerry 依赖', false, (err as Error).message, 'fatal', '执行 npm install --ignore-scripts');
  }

  // 8. 微信客户端版本
  const clients = detectWeChat();
  const allVersions = [...new Set(clients.map((c) => c.version))];
  const has39 = allVersions.some((v) => v.startsWith('3.9.'));
  const has12_17 = allVersions.some((v) => v === '3.9.12.17');
  const locationHint = clients
    .map((c) => `${c.version}${allVersions.length > 1 ? `（${c.dir}）` : ''}`)
    .join('、');
  add(
    '微信客户端',
    has12_17,
    clients.length ? `检测到：${locationHint}` : '没找到已安装的微信',
    has12_17 ? 'info' : 'fatal',
    has12_17
      ? undefined
      : has39
        ? '版本不是 3.9.12.17，WechatFerry 可能注入失败，建议装 3.9.12.17'
        : '需要单独安装微信 3.9.12.17（可以和现在的新版微信共存），详见 docs/01-安装微信3.9.12.17.md',
  );

  // 9. ffmpeg
  const ff = checkFfmpeg();
  add(
    'ffmpeg',
    Boolean(ff),
    ff ?? '未安装（只影响视频/语音理解，不影响文字聊天）',
    ff ? 'info' : 'warn',
    '下载静态版解压到 tools/ffmpeg/',
  );

  // 10. 权限配置
  add(
    '管理员白名单',
    config.bot.adminWxIds.length > 0,
    config.bot.adminWxIds.length ? `${config.bot.adminWxIds.length} 人` : '未配置（第一个发 /我是管理员 的人会拿到权限）',
    'info',
  );
  add(
    '群白名单',
    config.bot.allowedRooms.length > 0,
    config.bot.allowedRooms.length ? `${config.bot.allowedRooms.length} 个群` : '未限制（所有群都会应答，建议先限制）',
    'info',
  );

  // 输出
  const icon = (c: Check) => (c.ok ? '✔' : c.level === 'fatal' ? '✖' : '△');
  console.log('\n========== 环境体检 ==========\n');
  for (const c of checks) {
    console.log(`${icon(c)} ${c.name.padEnd(18)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`   → ${c.fix}`);
  }
  const fatalCount = checks.filter((c) => !c.ok && c.level === 'fatal').length;
  const warnCount = checks.filter((c) => !c.ok && c.level === 'warn').length;
  console.log(`\n结论：${fatalCount === 0 ? '可以启动 ✅' : `${fatalCount} 项阻塞`}${warnCount ? `，${warnCount} 项提醒` : ''}`);
  if (fatalCount === 0) console.log('启动：npm start（或先 npm run demo 在本地试聊）\n');
  else console.log('');

  closeDb();
  process.exit(fatalCount === 0 ? 0 : 1);
}

void main();
