/**
 * 管理后台：本地 HTTP 服务 + 单页界面。
 *
 * 只用 node:http，无第三方依赖。默认只监听 127.0.0.1，仅本机可访问。
 * 启动后浏览器打开 http://127.0.0.1:8898
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ROOT } from '../config.ts';
import { listStickers, deleteSticker, addStickerBase64, addStickerFile, stickerStats, listTrash, restoreSticker } from '../stickers/store.ts';
import {
  usageByChat,
  listShareCandidates,
  approveShareCandidate,
  rejectShareCandidate,
  updateMemoryContent,
  activityByDay,
} from '../memory/store.ts';
import { createLogger } from '../infra/logger.ts';
import { getDb } from '../infra/db.ts';
import type { Dispatcher } from '../core/dispatcher.ts';
import type { WeChatAdapter } from '../adapters/types.ts';
import {
  applyPreset,
  DEFAULT_PERSONA,
  getPersona,
  PRESETS,
  resetPersona,
  setPersona,
  describePersona,
} from '../core/persona.ts';
import { getSetting, listSettings, resetSetting, setSetting, type SettingView } from '../core/settings.ts';
import { listMemories, listDiary, usageSince, saveMemory, deleteMemory, searchMemories, updateMemory } from '../memory/store.ts';
import { beijingDate } from '../util.ts';
import type { Outgoing } from '../adapters/types.ts';

const log = createLogger('admin');
const HERE = dirname(fileURLToPath(import.meta.url));

export interface AdminOptions {
  dispatcher: Dispatcher;
  adapter: WeChatAdapter;
  port?: number;
}

let server: ReturnType<typeof createServer> | null = null;

function json(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) raw = raw.slice(0, 1_000_000);
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function todayStart(): number {
  return new Date(`${beijingDate()}T00:00:00+08:00`).getTime();
}

function recentChats(): { chatId: string; chatName: string; count: number; last: number }[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT chat_id AS chatId, COALESCE(chat_name, chat_id) AS chatName,
              COUNT(*) AS count, MAX(ts) AS last
       FROM messages GROUP BY chat_id ORDER BY last DESC LIMIT 50`,
    )
    .all() as { chatId: string; chatName: string; count: number; last: number }[];
  return rows;
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: AdminOptions,
): Promise<void> {
  const { dispatcher, adapter } = opts;
  const path = url.pathname;

  // ---------- 状态 ----------
  if (path === '/api/status' && req.method === 'GET') {
    const health = dispatcher.health();
    const stats = health.stats;
    const today = usageSince(todayStart());
    const week = usageSince(Date.now() - 7 * 24 * 3600_000);
    return json(res, 200, {
      ok: true,
      adapter: adapter.name,
      connected: health.adapterConnected,
      configured: health.configured,
      self: adapter.self(),
      uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
      stats,
      today,
      week,
      budget: getSetting('dailyBudgetCny'),
      triggerMode: getSetting('triggerMode'),
      node: process.version,
      env: config.env,
    });
  }

  // ---------- 设定 ----------
  if (path === '/api/settings' && req.method === 'GET') {
    return json(res, 200, { ok: true, settings: listSettings() });
  }
  if (path === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    const key = String(body.key ?? '');
    if (!key) return json(res, 400, { ok: false, error: '缺少 key' });
    const result = body.reset ? resetSetting(key) : setSetting(key, body.value);
    return json(res, result.ok ? 200 : 400, result);
  }

  // ---------- 人格 ----------
  if (path === '/api/persona' && req.method === 'GET') {
    const chat = url.searchParams.get('chat') ?? '';
    if (!chat) {
      return json(res, 200, { ok: true, chats: recentChats(), presets: Object.keys(PRESETS) });
    }
    return json(res, 200, {
      ok: true,
      chat,
      persona: getPersona(chat),
      presets: Object.keys(PRESETS),
      defaultPersona: DEFAULT_PERSONA,
      summary: describePersona(getPersona(chat)),
    });
  }
  if (path === '/api/persona' && req.method === 'POST') {
    const body = await readBody(req);
    const chat = String(body.chat ?? '');
    if (!chat) return json(res, 400, { ok: false, error: '缺少 chat' });
    if (body.preset === '__reset__') {
      resetPersona(chat);
      return json(res, 200, { ok: true, persona: getPersona(chat) });
    }
    if (typeof body.preset === 'string' && body.preset) {
      const p = applyPreset(chat, body.preset);
      if (!p) return json(res, 400, { ok: false, error: `没有预设 ${body.preset}` });
      return json(res, 200, { ok: true, persona: p });
    }
    const patch = (body.patch ?? {}) as Record<string, unknown>;
    const allowed: Record<string, unknown> = {};
    for (const k of ['name', 'style', 'temperature', 'maxChars', 'emoji', 'rules', 'examples']) {
      if (patch[k] !== undefined) allowed[k] = patch[k];
    }
    const p = setPersona(chat, allowed);
    return json(res, 200, { ok: true, persona: p });
  }

  // ---------- 日志 ----------
  if (path === '/api/logs' && req.method === 'GET') {
    const level = url.searchParams.get('level') ?? '';
    const limit = Math.min(300, Number(url.searchParams.get('limit') ?? 100) || 100);
    const db = getDb();
    const sql =
      level && level !== 'all'
        ? 'SELECT ts, level, module, msg, meta, fingerprint FROM logs WHERE level = ? ORDER BY ts DESC LIMIT ?'
        : 'SELECT ts, level, module, msg, meta, fingerprint FROM logs ORDER BY ts DESC LIMIT ?';
    const rows = (level && level !== 'all'
      ? db.prepare(sql).all(level, limit)
      : db.prepare(sql).all(limit)) as unknown[];
    return json(res, 200, { ok: true, logs: rows });
  }

  // ---------- 记忆 ----------
  if (path === '/api/memories' && req.method === 'GET') {
    const chat = url.searchParams.get('chat') ?? '';
    const q = url.searchParams.get('q') ?? '';
    if (!chat) return json(res, 200, { ok: true, chats: recentChats(), memories: [] });
    const list = q ? searchMemories(chat, q, 50) : listMemories(chat, 100);
    return json(res, 200, { ok: true, chat, memories: list });
  }
  if (path === '/api/memories' && req.method === 'POST') {
    const body = await readBody(req);
    const chat = String(body.chat ?? '');
    if (!chat) return json(res, 400, { ok: false, error: '缺少 chat' });
    if (body.delete) {
      const ok = deleteMemory(Number(body.delete), chat);
      return json(res, ok ? 200 : 400, { ok });
    }
    const content = String(body.content ?? '').trim();
    if (!content) return json(res, 400, { ok: false, error: '内容为空' });
    const id = saveMemory({ chatId: chat, content, pinned: Boolean(body.pinned), weight: body.pinned ? 1 : 0.6 });
    return json(res, 200, { ok: true, id });
  }

  // 设为核心记忆 / 取消核心
  if (path === '/api/memory/pin' && req.method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
    const pinned = Boolean(body.pinned);
    updateMemory(id, { pinned, weight: pinned ? 1 : 0.6 });
    return json(res, 200, { ok: true, id, pinned });
  }

  // ---------- 记忆编辑 ----------
  if (path === '/api/memory/update' && req.method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
    const ok = updateMemoryContent(id, {
      content: typeof body.content === 'string' ? body.content : undefined,
      weight: typeof body.weight === 'number' ? body.weight : undefined,
      pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
    });
    return json(res, ok ? 200 : 404, { ok, id });
  }

  // ---------- 人格批量应用 ----------
  if (path === '/api/persona/apply-all' && req.method === 'POST') {
    const body = await readBody(req);
    const from = String(body.from ?? '');
    if (!from) return json(res, 400, { ok: false, error: '缺少来源会话' });
    try {
      const src = getPersona(from);
      const rows = getDb()
        .prepare('SELECT DISTINCT chat_id AS c FROM messages ORDER BY ts DESC LIMIT 30')
        .all() as { c: string }[];
      let n = 0;
      for (const r of rows) {
        if (r.c === from) continue;
        setPersona(r.c, src);
        n++;
      }
      return json(res, 200, { ok: true, applied: n });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  // ---------- 对话热度报表 ----------
  if (path === '/api/stats/activity' && req.method === 'GET') {
    const days = Number(url.searchParams.get('days') ?? '7');
    try {
      const rows = activityByDay(days);
      const byDay = new Map<string, { messages: number; replied: number }>();
      for (const r of rows) {
        const d = byDay.get(r.date) ?? { messages: 0, replied: 0 };
        d.messages += r.messages;
        d.replied += r.replied;
        byDay.set(r.date, d);
      }
      return json(res, 200, {
        ok: true,
        days,
        rows,
        byDay: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, v]) => ({ date, ...v })),
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  // ---------- 共享记忆候选 ----------
  if (path === '/api/share/candidates' && req.method === 'GET') {
    try {
      const rows = listShareCandidates('pending', 100);
      return json(res, 200, { ok: true, candidates: rows });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }
  if (path === '/api/share/decision' && req.method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
    const approve = Boolean(body.approve);
    const ok = approve ? approveShareCandidate(id) : rejectShareCandidate(id);
    return json(res, ok ? 200 : 404, { ok, id, approve });
  }

  // ---------- 表情包管理 ----------
  if (path === '/api/stickers' && req.method === 'GET') {
    try {
      return json(res, 200, {
        ok: true,
        stats: stickerStats(),
        stickers: listStickers(),
        trash: listTrash().slice(0, 50),
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }
  if (path === '/api/stickers/add' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const r =
        typeof body.base64 === 'string' && body.base64
          ? addStickerBase64(body.base64)
          : addStickerFile(String(body.path ?? ''));
      return json(res, r.ok ? 200 : 400, r);
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }
  if (path === '/api/stickers/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name ?? '');
    if (!name) return json(res, 400, { ok: false, error: '缺少 name' });
    return json(res, deleteSticker(name) ? 200 : 404, { ok: true, name });
  }
  if (path === '/api/stickers/delete-many' && req.method === 'POST') {
    const body = await readBody(req);
    const names = Array.isArray(body.names) ? body.names.map((x: unknown) => String(x)) : [];
    if (!names.length) return json(res, 400, { ok: false, error: '缺少 names' });
    let done = 0;
    for (const n of names) if (deleteSticker(n)) done++;
    return json(res, 200, { ok: true, deleted: done, total: names.length });
  }
  if (path === '/api/stickers/restore' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name ?? '');
    if (!name) return json(res, 400, { ok: false, error: '缺少 name' });
    const ok = restoreSticker(name);
    return json(res, ok ? 200 : 404, { ok, name });
  }

  // ---------- 按会话统计用量 ----------
  if (path === '/api/usage/by-chat' && req.method === 'GET') {
    const days = Number(url.searchParams.get('days') ?? '7');
    const since = Date.now() - Math.max(1, Math.min(365, days)) * 86400_000;
    try {
      const rows = usageByChat(since);
      const total = rows.reduce(
        (a, r) => ({ calls: a.calls + r.calls, inTokens: a.inTokens + r.inTokens, outTokens: a.outTokens + r.outTokens, cost: a.cost + r.cost }),
        { calls: 0, inTokens: 0, outTokens: 0, cost: 0 },
      );
      return json(res, 200, { ok: true, days, total, chats: rows });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  // ---------- 调试 ----------
  if (path === '/api/bridge' && req.method === 'GET') {
    const base = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8899';
    const out: Record<string, unknown> = { ok: true };
    for (const key of ['health', 'detached', 'window']) {
      try {
        const r = await fetch(`${base}/${key}`, { signal: AbortSignal.timeout(4000) });
        out[key] = await r.json();
      } catch (err) {
        out[key] = { ok: false, error: (err as Error).message };
      }
    }
    return json(res, 200, out);
  }

  if (path === '/api/test/send' && req.method === 'POST') {
    const body = await readBody(req);
    const chat = String(body.chat ?? '');
    const text = String(body.text ?? '').trim();
    if (!chat || !text) return json(res, 400, { ok: false, error: '需要 chat 和 text' });
    try {
      const ok = await opts.dispatcher.debugSendText(chat, text);
      return json(res, ok ? 200 : 500, { ok });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  if (path === '/api/test/voice' && req.method === 'POST') {
    const body = await readBody(req);
    const chat = String(body.chat ?? '');
    const text = String(body.text ?? '').trim() || '这是语音测试，能听到吗？';
    if (!chat) return json(res, 400, { ok: false, error: '缺少 chat' });
    try {
      const r = await opts.dispatcher.debugSendVoice(chat, text);
      return json(res, r.ok ? 200 : 500, r);
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  if (path === '/api/test/sticker' && req.method === 'POST') {
    const body = await readBody(req);
    const chat = String(body.chat ?? '');
    if (!chat) return json(res, 400, { ok: false, error: '缺少 chat' });
    try {
      const r = await opts.dispatcher.debugSendSticker(chat);
      return json(res, r.ok ? 200 : 500, r);
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  if (path === '/api/test/browse' && req.method === 'POST') {
    const body = await readBody(req);
    const chat = String(body.chat ?? '');
    if (!chat) return json(res, 400, { ok: false, error: '缺少 chat' });
    try {
      const { browseOnce } = await import('../integrations/learn.ts');
      const r = await browseOnce(chat);
      return json(res, r.ok ? 200 : 500, r);
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  if (path === '/api/sync/whale' && req.method === 'POST') {
    try {
      const { spawn } = await import('node:child_process');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      const script = join(root, 'src', 'cli', 'sync-whale.ts');
      const lines: string[] = [];
      const code = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [script], { cwd: root, windowsHide: true });
        child.stdout?.on('data', (b: Buffer) => lines.push(b.toString('utf8')));
        child.stderr?.on('data', (b: Buffer) => lines.push(b.toString('utf8')));
        child.on('exit', (c2) => resolve(c2 ?? 1));
        child.on('error', () => resolve(1));
      });
      const out = lines.join('').split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
      return json(res, code === 0 ? 200 : 500, { ok: code === 0, code, log: out });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  if (path === '/api/sync/bili' && req.method === 'POST') {
    const body = await readBody(req);
    const chat = String(body.chat ?? '');
    try {
      const { spawn } = await import('node:child_process');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      const script = join(root, 'src', 'cli', 'sync-bili.ts');
      const args = [script];
      if (chat) args.push('--chat', chat);
      const lines: string[] = [];
      const code = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, args, { cwd: root, windowsHide: true });
        child.stdout?.on('data', (b: Buffer) => lines.push(b.toString('utf8')));
        child.stderr?.on('data', (b: Buffer) => lines.push(b.toString('utf8')));
        child.on('exit', (c) => resolve(c ?? 1));
        child.on('error', () => resolve(1));
      });
      const out = lines.join('').split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
      return json(res, code === 0 ? 200 : 500, { ok: code === 0, code, log: out });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  // ---------- 日记 ----------
  if (path === '/api/diary' && req.method === 'GET') {
    const chat = url.searchParams.get('chat') ?? '';
    if (!chat) return json(res, 200, { ok: true, chats: recentChats(), diary: [] });
    return json(res, 200, { ok: true, chat, diary: listDiary(chat, 60) });
  }

  // ---------- 用量 ----------
  if (path === '/api/usage' && req.method === 'GET') {
    const db = getDb();
    const days: { date: string; calls: number; cost: number; inTok: number; outTok: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000);
      const start = new Date(`${beijingDate(d)}T00:00:00+08:00`).getTime();
      const end = start + 86400_000;
      const row = db
        .prepare(
          'SELECT COUNT(*) AS c, COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(in_tokens),0) AS it, COALESCE(SUM(out_tokens),0) AS ot FROM usage WHERE ts >= ? AND ts < ?',
        )
        .get(start, end) as { c: number; cost: number; it: number; ot: number };
      days.push({ date: beijingDate(d), calls: Number(row.c), cost: Number(row.cost), inTok: Number(row.it), outTok: Number(row.ot) });
    }
    return json(res, 200, { ok: true, days, settings: listSettings().filter((s) => s.group === '预算') });
  }

  // ---------- 会话 ----------
  if (path === '/api/chats' && req.method === 'GET') {
    return json(res, 200, { ok: true, chats: recentChats() });
  }

  // ---------- 手动发消息（测试用） ----------
  if (path === '/api/send' && req.method === 'POST') {
    const body = await readBody(req);
    const chat = String(body.chat ?? '');
    const text = String(body.text ?? '').trim();
    if (!chat || !text) return json(res, 400, { ok: false, error: '缺少 chat 或 text' });
    try {
      await adapter.send(chat, { kind: 'text', text } as Outgoing);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  return json(res, 404, { ok: false, error: 'not found' });
}

function serveIndex(res: ServerResponse): void {
  const file = join(HERE, 'web', 'index.html');
  if (!existsSync(file)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('缺少 web/index.html');
    return;
  }
  const html = readFileSync(file, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

export function startAdmin(opts: AdminOptions): void {
  if (server) return;
  const port = opts.port ?? Number(process.env.ADMIN_PORT ?? 8898);

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveIndex(res);
    }
    // 表情包图片
    if (url.pathname.startsWith('/stickers/')) {
      const name = decodeURIComponent(url.pathname.slice('/stickers/'.length)).replace(/[\\/]/g, '');
      const file = join(ROOT, 'data', 'stickers', name);
      if (!existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      const mime =
        ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(readFileSync(file));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url, opts).catch((err) => {
        log.error('后台接口异常', { path: url.pathname, err: (err as Error).message });
        json(res, 500, { ok: false, error: (err as Error).message });
      });
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  });

  server.listen(port, '127.0.0.1', () => {
    log.info('管理后台已启动', { url: `http://127.0.0.1:${port}` });
  });
  server.on('error', (err) => {
    log.error('管理后台启动失败', { err: err.message, port });
  });
}

export function stopAdmin(): void {
  server?.close();
  server = null;
}
