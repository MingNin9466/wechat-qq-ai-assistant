/**
 * 记忆存储层：对 db.ts 的业务封装（所有 SQL 都在这里，业务层不写 SQL）。
 *
 * 分层对应关系：
 *   messages  -> L0 原文
 *   summaries -> L1/L2/L3 摘要（level 区分）
 *   diary     -> L2 日记
 *   memories  -> L3 长期记忆
 *   events    -> append-only 真相源
 */
import { getDb, type Db } from '../infra/db.ts';
import type { LogRow } from '../infra/logger.ts';
import { estimateTokens } from '../util.ts';

// ---------------------------------------------------------------- 事件（真相源）

export function saveEvent(kind: string, payload: unknown, chatId = '', refId?: string): number {
  const db = getDb();
  const r = db
    .prepare('INSERT INTO events (ts, chat_id, kind, payload, ref_id) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), chatId, kind, JSON.stringify(payload), refId ?? null);
  return Number(r.lastInsertRowid);
}

// ---------------------------------------------------------------- L0 消息

export interface MessageInput {
  chatId: string;
  chatName?: string;
  msgId?: string;
  senderId: string;
  senderName?: string;
  role: 'user' | 'assistant';
  kind: string;
  content: string;
  mediaPath?: string;
  ts?: number;
  eventId?: number;
}

export interface StoredMessage {
  id: number;
  chat_id: string;
  chat_name: string | null;
  msg_id: string | null;
  sender_id: string;
  sender_name: string | null;
  role: 'user' | 'assistant';
  kind: string;
  content: string | null;
  media_path: string | null;
  ts: number;
  tokens: number;
}

export function saveMessage(m: MessageInput): number {
  const db = getDb();
  const ts = m.ts ?? Date.now();
  const tokens = estimateTokens(m.content ?? '');
  const r = db
    .prepare(
      `INSERT INTO messages
       (event_id, chat_id, chat_name, msg_id, sender_id, sender_name, role, kind, content, media_path, ts, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.eventId ?? null,
      m.chatId,
      m.chatName ?? null,
      m.msgId ?? null,
      m.senderId,
      m.senderName ?? null,
      m.role,
      m.kind,
      m.content ?? '',
      m.mediaPath ?? null,
      ts,
      tokens,
    );
  return Number(r.lastInsertRowid);
}

export function hasMessage(chatId: string, msgId: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT 1 AS x FROM messages WHERE chat_id = ? AND msg_id = ? LIMIT 1')
    .get(chatId, msgId) as { x: number } | undefined;
  return Boolean(row);
}

export function getRecentMessages(chatId: string, limit = 20, sinceTs?: number): StoredMessage[] {
  const db = getDb();
  const rows = sinceTs
    ? db
        .prepare(
          'SELECT * FROM messages WHERE chat_id = ? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT ?',
        )
        .all(chatId, sinceTs, limit)
    : db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(chatId, limit);
  return (rows as unknown as StoredMessage[]).reverse();
}

export function countMessagesSince(chatId: string, sinceTs: number): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ? AND ts >= ?')
    .get(chatId, sinceTs) as { c: number };
  return Number(row.c);
}

export function getUndistilledMessages(chatId: string, sinceTs: number, limit = 80): StoredMessage[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM messages WHERE chat_id = ? AND ts >= ? ORDER BY ts ASC, id ASC LIMIT ?',
    )
    .all(chatId, sinceTs, limit);
  return rows as unknown as StoredMessage[];
}

export function searchMessages(chatId: string, query: string, limit = 10, sinceTs = 0): StoredMessage[] {
  const db = getDb();
  const q = query.trim();
  if (!q) return [];
  // trigram 需要至少 3 个字符；不足 3 字退回 LIKE
  try {
    if ([...q].length >= 3) {
      const rows = db
        .prepare(
          `SELECT m.* FROM msg_fts f JOIN messages m ON m.id = f.rowid
           WHERE f.content MATCH ? AND m.chat_id = ? AND m.ts >= ?
           ORDER BY rank LIMIT ?`,
        )
        .all(q, chatId, sinceTs, limit);
      if (rows.length > 0) return rows as unknown as StoredMessage[];
    }
  } catch {
    /* FTS 语法问题就退回 LIKE */
  }
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE chat_id = ? AND ts >= ? AND content LIKE ?
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(chatId, sinceTs, `%${q}%`, limit);
  return rows as unknown as StoredMessage[];
}

// ---------------------------------------------------------------- L1/L2 摘要

export interface SummaryInput {
  chatId: string;
  level: number; // 1=会话 2=日 3=周 4=月
  periodStart: number;
  periodEnd: number;
  content: string;
  sourceIds?: number[];
}

export interface StoredSummary {
  id: number;
  chat_id: string;
  level: number;
  period_start: number;
  period_end: number;
  content: string;
  source_ids: string | null;
  tokens: number;
  created_at: number;
}

export function saveSummary(s: SummaryInput): number {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT INTO summaries (chat_id, level, period_start, period_end, content, source_ids, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.chatId,
      s.level,
      s.periodStart,
      s.periodEnd,
      s.content,
      s.sourceIds ? JSON.stringify(s.sourceIds) : null,
      estimateTokens(s.content),
      Date.now(),
    );
  return Number(r.lastInsertRowid);
}

export function getRecentSummaries(chatId: string, level: number, limit = 5): StoredSummary[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM summaries WHERE chat_id = ? AND level = ? ORDER BY period_end DESC LIMIT ?')
    .all(chatId, level, limit);
  return (rows as unknown as StoredSummary[]).reverse();
}

export function searchSummaries(chatId: string, query: string, limit = 5): StoredSummary[] {
  const db = getDb();
  const q = query.trim();
  if (!q) return [];
  try {
    if ([...q].length >= 3) {
      const rows = db
        .prepare(
          `SELECT s.* FROM summary_fts f JOIN summaries s ON s.id = f.rowid
           WHERE f.content MATCH ? AND s.chat_id = ? ORDER BY rank LIMIT ?`,
        )
        .all(q, chatId, limit);
      if (rows.length > 0) return rows as unknown as StoredSummary[];
    }
  } catch {
    /* fallthrough */
  }
  const rows = db
    .prepare('SELECT * FROM summaries WHERE chat_id = ? AND content LIKE ? ORDER BY period_end DESC LIMIT ?')
    .all(chatId, `%${q}%`, limit);
  return rows as unknown as StoredSummary[];
}

/** 某天是否已经有 L2 摘要（避免重复生成日记） */
export function hasSummaryForDay(chatId: string, dayStart: number, dayEnd: number): boolean {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT 1 AS x FROM summaries WHERE chat_id = ? AND level = 2 AND period_start >= ? AND period_start < ? LIMIT 1',
    )
    .get(chatId, dayStart, dayEnd) as { x: number } | undefined;
  return Boolean(row);
}

/** 最近一次 L1 摘要的结束时间（用于决定下次从哪开始蒸馏） */
export function lastSummaryEnd(chatId: string, level: number): number {
  const db = getDb();
  const row = db
    .prepare('SELECT MAX(period_end) AS m FROM summaries WHERE chat_id = ? AND level = ?')
    .get(chatId, level) as { m: number | null };
  return Number(row.m ?? 0);
}

// ---------------------------------------------------------------- L3 长期记忆

export interface MemoryInput {
  chatId: string;
  scope?: 'group' | 'member' | 'global';
  subject?: string;
  kind?: 'fact' | 'pref' | 'convention' | 'todo' | 'relation';
  content: string;
  weight?: number;
  pinned?: boolean;
  sourceIds?: number[];
}

export interface StoredMemory {
  id: number;
  chat_id: string;
  scope: string;
  subject: string | null;
  kind: string;
  content: string;
  weight: number;
  pinned: number;
  source_ids: string | null;
  hits: number;
  last_hit: number | null;
  created_at: number;
  updated_at: number;
  version: number;
}

export function saveMemory(m: MemoryInput): number {
  const db = getDb();
  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO memories (chat_id, scope, subject, kind, content, weight, pinned, source_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.chatId,
      m.scope ?? 'group',
      m.subject ?? null,
      m.kind ?? 'fact',
      m.content,
      m.weight ?? 0.5,
      m.pinned ? 1 : 0,
      m.sourceIds ? JSON.stringify(m.sourceIds) : null,
      now,
      now,
    );
  return Number(r.lastInsertRowid);
}

export function updateMemory(id: number, patch: { content?: string; weight?: number; pinned?: boolean }): void {
  const db = getDb();
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.content !== undefined) {
    sets.push('content = ?');
    vals.push(patch.content);
  }
  if (patch.weight !== undefined) {
    sets.push('weight = ?');
    vals.push(patch.weight);
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?');
    vals.push(patch.pinned ? 1 : 0);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?', 'version = version + 1');
  vals.push(Date.now(), id);
  db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteMemory(id: number, chatId?: string): boolean {
  const db = getDb();
  const r = chatId
    ? db.prepare('DELETE FROM memories WHERE id = ? AND chat_id = ?').run(id, chatId)
    : db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return Number(r.changes) > 0;
}


/** 写一条"所有聊天共享"的记忆（chat_id = __shared__） */
export function saveSharedMemory(m: Omit<MemoryInput, 'chatId'>): number {
  return saveMemory({ ...m, chatId: '__shared__', scope: 'global' });
}

/** 把某个群的某条记忆提升为全局共享 */
export function promoteToShared(id: number): boolean {
  const db = getDb();
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as StoredMemory | undefined;
  if (!row) return false;
  const dup = db
    .prepare("SELECT id FROM memories WHERE chat_id = '__shared__' AND content = ? LIMIT 1")
    .get(row.content) as { id: number } | undefined;
  if (dup) return true;
  saveMemory({
    chatId: '__shared__',
    scope: 'global',
    content: row.content,
    kind: row.kind as MemoryInput['kind'],
    weight: Math.max(0.8, row.weight),
    pinned: Boolean(row.pinned),
  });
  return true;
}


/** 共享记忆候选：先排队，由人在后台确认后才进 __shared__ */
export interface ShareCandidate {
  id: number;
  chatId: string;
  content: string;
  kind: string;
  weight: number;
  status: string;
  source: string;
  createdAt: number;
}

export function addShareCandidate(m: { chatId: string; content: string; kind?: string; weight?: number; source?: string }): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO share_candidates (chat_id, content, kind, weight, source, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(m.chatId, m.content, m.kind ?? 'fact', m.weight ?? 0.7, m.source ?? 'chat', Date.now());
}

export function listShareCandidates(status = 'pending', limit = 100): ShareCandidate[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM share_candidates WHERE status = ? ORDER BY created_at DESC LIMIT ?')
    .all(status, limit) as { id: number; chat_id: string; content: string; kind: string; weight: number; status: string; source: string; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    content: r.content,
    kind: r.kind,
    weight: r.weight,
    status: r.status,
    source: r.source,
    createdAt: r.created_at,
  }));
}

/** 通过：写进全局共享记忆 */
export function approveShareCandidate(id: number): boolean {
  const db = getDb();
  const row = db.prepare('SELECT * FROM share_candidates WHERE id = ?').get(id) as
    | { chat_id: string; content: string; kind: string; weight: number }
    | undefined;
  if (!row) return false;
  const dup = db
    .prepare("SELECT id FROM memories WHERE chat_id = '__shared__' AND content = ? LIMIT 1")
    .get(row.content) as { id: number } | undefined;
  if (!dup) {
    saveMemory({
      chatId: '__shared__',
      scope: 'global',
      content: row.content,
      kind: row.kind as MemoryInput['kind'],
      weight: Math.max(0.8, row.weight),
    });
  }
  db.prepare("UPDATE share_candidates SET status = 'approved', decided_at = ? WHERE id = ?").run(Date.now(), id);
  return true;
}

export function rejectShareCandidate(id: number): boolean {
  const db = getDb();
  const r = db
    .prepare("UPDATE share_candidates SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(Date.now(), id);
  return Number(r.changes) > 0;
}


/** 改记忆内容 / 权重 */
export function updateMemoryContent(id: number, patch: { content?: string; weight?: number; pinned?: boolean }): boolean {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof patch.content === 'string' && patch.content.trim()) {
    sets.push('content = ?');
    vals.push(patch.content.trim());
  }
  if (typeof patch.weight === 'number') {
    sets.push('weight = ?');
    vals.push(Math.min(1, Math.max(0.1, patch.weight)));
  }
  if (typeof patch.pinned === 'boolean') {
    sets.push('pinned = ?');
    vals.push(patch.pinned ? 1 : 0);
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  vals.push(Date.now());
  vals.push(id);
  const r = db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  return Number(r.changes) > 0;
}

/** 按天统计各会话的消息量（做对话热度报表） */
export interface DayChatStat {
  date: string;
  chatId: string;
  messages: number;
  replied: number;
}

export function activityByDay(days = 7): DayChatStat[] {
  const db = getDb();
  const since = Date.now() - Math.max(1, Math.min(90, days)) * 86400_000;
  const rows = db
    .prepare(
      `SELECT date(ts / 1000, 'unixepoch', '+8 hours') AS d,
              chat_id AS c,
              COUNT(*) AS n,
              SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS r
         FROM messages WHERE ts >= ?
         GROUP BY d, c ORDER BY d DESC, n DESC`,
    )
    .all(since) as { d: string; c: string; n: number; r: number }[];
  return rows.map((x) => ({ date: x.d, chatId: x.c, messages: Number(x.n) || 0, replied: Number(x.r) || 0 }));
}

export function listMemories(chatId: string, limit = 50, pinnedFirst = true): StoredMemory[] {
  const db = getDb();
  const order = pinnedFirst ? 'pinned DESC, weight DESC, updated_at DESC' : 'updated_at DESC';
  const rows = db.prepare(`SELECT * FROM memories WHERE chat_id IN (?, '__shared__') ORDER BY ${order} LIMIT ?`).all(chatId, limit);
  return rows as unknown as StoredMemory[];
}

export function getPinnedMemories(chatId: string, limit = 20): StoredMemory[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM memories WHERE chat_id IN (?, '__shared__') AND pinned = 1 ORDER BY weight DESC, updated_at DESC LIMIT ?",
    )
    .all(chatId, limit);
  return rows as unknown as StoredMemory[];
}

/** 记忆检索：FTS（≥3字）+ LIKE 兜底，命中后累加 hits */
export function searchMemories(chatId: string, query: string, limit = 8): StoredMemory[] {
  const db = getDb();
  const q = query.trim();
  if (!q) return [];
  let rows: unknown[] = [];
  try {
    if ([...q].length >= 3) {
      rows = db
        .prepare(
          `SELECT m.* FROM mem_fts f JOIN memories m ON m.id = f.rowid
           WHERE f.content MATCH ? AND m.chat_id IN (?, '__shared__') ORDER BY rank LIMIT ?`,
        )
        .all(q, chatId, limit);
    }
  } catch {
    rows = [];
  }
  if (rows.length === 0) {
    rows = db
      .prepare('SELECT * FROM memories WHERE chat_id = ? AND content LIKE ? ORDER BY weight DESC LIMIT ?')
      .all(chatId, `%${q}%`, limit);
  }
  const list = rows as unknown as StoredMemory[];
  const now = Date.now();
  const stmt = db.prepare('UPDATE memories SET hits = hits + 1, last_hit = ? WHERE id = ?');
  for (const m of list) {
    try {
      stmt.run(now, m.id);
    } catch {
      /* ignore */
    }
  }
  return list;
}

/** 去重检查：内容高度相似的记忆是否已存在（用长度+前缀粗判，避免重复写入） */
export function findSimilarMemory(chatId: string, content: string): StoredMemory | null {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM memories WHERE chat_id = ? AND content = ? LIMIT 1')
    .get(chatId, content) as StoredMemory | undefined;
  return rows ?? null;
}

// ---------------------------------------------------------------- L2 日记

export interface DiaryInput {
  chatId: string;
  date: string;
  content: string;
  topics?: string[];
  highlights?: string[];
  todos?: string[];
  mood?: string;
}

export function saveDiary(d: DiaryInput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO diary (chat_id, date, content, topics, highlights, todos, mood, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, date) DO UPDATE SET
       content = excluded.content, topics = excluded.topics, highlights = excluded.highlights,
       todos = excluded.todos, mood = excluded.mood`,
  ).run(
    d.chatId,
    d.date,
    d.content,
    JSON.stringify(d.topics ?? []),
    JSON.stringify(d.highlights ?? []),
    JSON.stringify(d.todos ?? []),
    d.mood ?? '',
    Date.now(),
  );
}

export interface StoredDiary {
  id: number;
  chat_id: string;
  date: string;
  content: string;
  topics: string;
  highlights: string;
  todos: string;
  mood: string;
  created_at: number;
}

export function getDiary(chatId: string, date: string): StoredDiary | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM diary WHERE chat_id = ? AND date = ?').get(chatId, date) as
    | StoredDiary
    | undefined;
  return row ?? null;
}

export function listDiary(chatId: string, limit = 14): StoredDiary[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM diary WHERE chat_id = ? ORDER BY date DESC LIMIT ?').all(chatId, limit);
  return rows as unknown as StoredDiary[];
}

export function searchDiary(chatId: string, keyword: string, limit = 10): StoredDiary[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM diary WHERE chat_id = ? AND (content LIKE ? OR topics LIKE ?) ORDER BY date DESC LIMIT ?')
    .all(chatId, `%${keyword}%`, `%${keyword}%`, limit);
  return rows as unknown as StoredDiary[];
}

// ---------------------------------------------------------------- 配置 kv

export function kvGet(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

export function kvGetJson<T>(key: string, fallback: T): T {
  const raw = kvGet(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function kvSetJson(key: string, value: unknown): void {
  kvSet(key, JSON.stringify(value));
}

export function kvDelete(key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}

// ---------------------------------------------------------------- 日志 / 用量

export function addLogRow(row: LogRow): void {
  const db = getDb();
  db.prepare('INSERT INTO logs (ts, level, module, msg, meta, fingerprint) VALUES (?, ?, ?, ?, ?, ?)').run(
    row.ts,
    row.level,
    row.module,
    row.msg,
    row.meta ? JSON.stringify(row.meta) : null,
    row.fingerprint,
  );
}

export interface UsageInput {
  chatId?: string;
  kind: 'chat' | 'vision' | 'search' | 'fetch' | 'asr' | 'distill';
  model?: string;
  inTokens?: number;
  outTokens?: number;
  cachedTokens?: number;
  cost?: number;
}


/** 按会话统计用量与花费（sinceMs 起） */
export interface ChatUsage {
  chatId: string;
  calls: number;
  inTokens: number;
  outTokens: number;
  cost: number;
  lastAt: number;
}

export function usageByChat(sinceMs: number): ChatUsage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT COALESCE(chat_id, '(未知)') AS c,
              COUNT(*) AS calls,
              SUM(in_tokens) AS i,
              SUM(out_tokens) AS o,
              SUM(cost) AS cost,
              MAX(ts) AS last
         FROM usage WHERE ts >= ? GROUP BY c ORDER BY cost DESC`,
    )
    .all(sinceMs) as { c: string; calls: number; i: number; o: number; cost: number; last: number }[];
  return rows.map((r) => ({
    chatId: r.c,
    calls: Number(r.calls) || 0,
    inTokens: Number(r.i) || 0,
    outTokens: Number(r.o) || 0,
    cost: Number(r.cost) || 0,
    lastAt: Number(r.last) || 0,
  }));
}

export function addUsage(u: UsageInput): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO usage (ts, chat_id, kind, model, in_tokens, out_tokens, cached_tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    Date.now(),
    u.chatId ?? null,
    u.kind,
    u.model ?? null,
    u.inTokens ?? 0,
    u.outTokens ?? 0,
    u.cachedTokens ?? 0,
    u.cost ?? 0,
  );
}

export function usageSince(sinceTs: number): { cost: number; inTokens: number; outTokens: number; calls: number } {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(in_tokens),0) AS it, COALESCE(SUM(out_tokens),0) AS ot, COUNT(*) AS c FROM usage WHERE ts >= ?',
    )
    .get(sinceTs) as { cost: number; it: number; ot: number; c: number };
  return { cost: Number(row.cost), inTokens: Number(row.it), outTokens: Number(row.ot), calls: Number(row.c) };
}

export function recentErrors(limit = 20): { ts: number; module: string; msg: string; fingerprint: string; count: number }[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT MIN(ts) AS ts, module, MIN(msg) AS msg, fingerprint, COUNT(*) AS count
       FROM logs WHERE level IN ('error','fatal') AND ts >= ?
       GROUP BY fingerprint ORDER BY ts DESC LIMIT ?`,
    )
    .all(Date.now() - 7 * 24 * 3600 * 1000, limit);
  return rows as unknown as { ts: number; module: string; msg: string; fingerprint: string; count: number }[];
}

// ---------------------------------------------------------------- 维护

/** 把超过 retentionDays 的原文从 messages 里归档出去（导出 JSONL 后删除），FTS 索引随之清理 */
export function archiveOldMessages(dbArg?: Db): number {
  const db = dbArg ?? getDb();
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  const rows = db.prepare('SELECT * FROM messages WHERE ts < ? ORDER BY ts ASC').all(cutoff) as unknown as StoredMessage[];
  if (rows.length === 0) return 0;
  return rows.length;
}

export function statsFor(chatId: string): { messages: number; memories: number; summaries: number; diary: number } {
  const db = getDb();
  const q = (sql: string) => Number((db.prepare(sql).get(chatId) as { c: number }).c);
  return {
    messages: q('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ?'),
    memories: q('SELECT COUNT(*) AS c FROM memories WHERE chat_id = ?'),
    summaries: q('SELECT COUNT(*) AS c FROM summaries WHERE chat_id = ?'),
    diary: q('SELECT COUNT(*) AS c FROM diary WHERE chat_id = ?'),
  };
}
