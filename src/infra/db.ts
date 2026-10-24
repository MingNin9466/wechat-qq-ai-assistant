/**
 * SQLite 存储层（node:sqlite 内置，零依赖）。
 *
 * 设计要点：
 *  - events 是 append-only 的「真相源」，所有输入输出先记事件，再更新派生表，坏了能重建。
 *  - 迁移用 PRAGMA user_version 版本号，迁移前自动快照。
 *  - 中文检索用 FTS5 trigram（≥3 字），短查询由上层退回 LIKE。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';

export type Db = DatabaseSync;

let db: Db | null = null;

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    // 共享候选增加来源标记（chat=聊天提炼 / bili=B站信笺 / diary=日记）
    version: 4,
    name: 'share-candidate-source',
    sql: `
ALTER TABLE share_candidates ADD COLUMN source TEXT NOT NULL DEFAULT 'chat';
CREATE INDEX IF NOT EXISTS idx_share_cand_source ON share_candidates(source, status);
`,
  },
  {
    // 共享记忆候选队列：模型提炼出的记忆先进这里，由人在后台确认后才会变成全局共享
    version: 3,
    name: 'share-candidates',
    sql: `
CREATE TABLE IF NOT EXISTS share_candidates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'fact',
  weight     REAL NOT NULL DEFAULT 0.7,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_cand_unique ON share_candidates(chat_id, content);
CREATE INDEX IF NOT EXISTS idx_share_cand_status ON share_candidates(status, created_at);
`,
  },
  {
    // 修 FTS 触发器：mem_fts 是标准 FTS5 表（不是 external content），
    // 用 'delete' 特殊语法会报 "SQL logic error"，改成普通 DELETE。
    version: 2,
    name: 'fix-mem-fts-triggers',
    sql: `
DROP TRIGGER IF EXISTS trg_mem_ad;
CREATE TRIGGER trg_mem_ad AFTER DELETE ON memories BEGIN
  DELETE FROM mem_fts WHERE rowid = old.id;
END;

DROP TRIGGER IF EXISTS trg_mem_au;
CREATE TRIGGER trg_mem_au AFTER UPDATE ON memories BEGIN
  DELETE FROM mem_fts WHERE rowid = old.id;
  INSERT INTO mem_fts(rowid, content) VALUES (new.id, new.content);
END;

DROP TRIGGER IF EXISTS trg_mem_ai;
CREATE TRIGGER trg_mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO mem_fts(rowid, content) VALUES (new.id, new.content);
END;
`,
  },
  {
    version: 1,
    name: 'init',
    sql: `
-- ========== 真相源 ==========
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  chat_id   TEXT    NOT NULL DEFAULT '',
  kind      TEXT    NOT NULL,
  payload   TEXT    NOT NULL,
  ref_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_chat ON events(chat_id, ts);

-- ========== L0 原始消息 ==========
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER,
  chat_id     TEXT    NOT NULL,
  chat_name   TEXT,
  msg_id      TEXT,
  sender_id   TEXT    NOT NULL,
  sender_name TEXT,
  role        TEXT    NOT NULL,          -- user / assistant
  kind        TEXT    NOT NULL,          -- text/image/voice/video/file/link/...
  content     TEXT,
  media_path  TEXT,
  ts          INTEGER NOT NULL,
  tokens      INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_msgid ON messages(chat_id, msg_id) WHERE msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);

-- ========== L1 摘要 ==========
CREATE TABLE IF NOT EXISTS summaries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        TEXT    NOT NULL,
  level          INTEGER NOT NULL,       -- 1=会话 2=日 3=周 4=月
  period_start   INTEGER NOT NULL,
  period_end     INTEGER NOT NULL,
  content        TEXT    NOT NULL,
  source_ids     TEXT,
  tokens         INTEGER DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_chat ON summaries(chat_id, level, period_end);

-- ========== L2 日记 ==========
CREATE TABLE IF NOT EXISTS diary (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  date       TEXT NOT NULL,
  content    TEXT NOT NULL,
  topics     TEXT,
  highlights TEXT,
  todos      TEXT,
  mood       TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_diary ON diary(chat_id, date);

-- ========== L3 长期记忆 ==========
CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'group',   -- group/member/global
  subject     TEXT,
  kind        TEXT NOT NULL DEFAULT 'fact',    -- fact/pref/convention/todo/relation
  content     TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 0.5,
  pinned      INTEGER NOT NULL DEFAULT 0,
  source_ids  TEXT,
  hits        INTEGER NOT NULL DEFAULT 0,
  last_hit    INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id, pinned, weight);

-- ========== 检索索引 ==========
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
  content, content='messages', content_rowid='id', tokenize='trigram'
);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  content, tokenize='trigram'
);
CREATE VIRTUAL TABLE IF NOT EXISTS summary_fts USING fts5(
  content, tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO msg_fts(rowid, content) VALUES (new.id, COALESCE(new.content, ''));
END;
CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO msg_fts(msg_fts, rowid, content) VALUES ('delete', old.id, COALESCE(old.content, ''));
END;
CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO msg_fts(msg_fts, rowid, content) VALUES ('delete', old.id, COALESCE(old.content, ''));
  INSERT INTO msg_fts(rowid, content) VALUES (new.id, COALESCE(new.content, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO mem_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS trg_mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS trg_mem_au AFTER UPDATE ON memories BEGIN
  INSERT INTO mem_fts(mem_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO mem_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_sum_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summary_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS trg_sum_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summary_fts(summary_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- ========== 配置 ==========
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ========== 运维 ==========
CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  level       TEXT NOT NULL,
  module      TEXT NOT NULL,
  msg         TEXT NOT NULL,
  meta        TEXT,
  fingerprint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, ts);
CREATE INDEX IF NOT EXISTS idx_logs_fp ON logs(fingerprint);

CREATE TABLE IF NOT EXISTS usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  chat_id     TEXT,
  kind        TEXT NOT NULL,      -- chat/vision/search/fetch/asr
  model       TEXT,
  in_tokens   INTEGER DEFAULT 0,
  out_tokens  INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  cost        REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);

CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256     TEXT UNIQUE,
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  size       INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS backups (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  path    TEXT NOT NULL,
  size    INTEGER,
  note    TEXT
);
`,
  },
];

function applyMigrations(conn: Db): void {
  const row = conn.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    conn.exec('BEGIN');
    try {
      conn.exec(m.sql);
      conn.exec(`PRAGMA user_version = ${m.version}`);
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw new Error(`迁移 v${m.version} (${m.name}) 失败: ${(err as Error).message}`);
    }
  }
}

export function openDb(file: string = config.storage.dbFile): Db {
  if (db) return db;
  mkdirSync(dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA synchronous = NORMAL');
  conn.exec('PRAGMA busy_timeout = 5000');
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec('PRAGMA temp_store = MEMORY');
  applyMigrations(conn);
  db = conn;
  return conn;
}

export function getDb(): Db {
  if (!db) return openDb();
  return db;
}

export function closeDb(): void {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* ignore */
  }
  try {
    db.close();
  } catch {
    /* ignore */
  }
  db = null;
}

/** 在线备份（VACUUM INTO，不锁表），返回备份文件路径 */
export function backupNow(note = 'manual'): string {
  const conn = getDb();
  const dir = config.storage.backupDir;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const file = join(dir, `bot-${stamp}.sqlite`);
  const escaped = file.replace(/'/g, "''");
  conn.exec(`VACUUM INTO '${escaped}'`);
  const size = existsSync(file) ? statSync(file).size : 0;
  conn
    .prepare('INSERT INTO backups (ts, path, size, note) VALUES (?, ?, ?, ?)')
    .run(Date.now(), file, size, note);
  return file;
}

/** 保留最近 keep 份备份，其余删除 */
export function pruneBackups(keep = 30): number {
  const conn = getDb();
  const rows = conn
    .prepare('SELECT id, path FROM backups ORDER BY ts DESC')
    .all() as { id: number; path: string }[];
  const extra = rows.slice(keep);
  let removed = 0;
  for (const r of extra) {
    try {
      if (existsSync(r.path)) {
        unlinkSync(r.path);
      }
      conn.prepare('DELETE FROM backups WHERE id = ?').run(r.id);
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export interface HealthReport {
  ok: boolean;
  integrity: string;
  tables: string[];
  dbSizeBytes: number;
  userVersion: number;
  walSizeBytes: number;
}

export function healthCheck(): HealthReport {
  const conn = getDb();
  const integrityRow = conn.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
  const tables = (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
  const versionRow = conn.prepare('PRAGMA user_version').get() as { user_version?: number };
  const dbSize = existsSync(config.storage.dbFile) ? statSync(config.storage.dbFile).size : 0;
  const walPath = config.storage.dbFile + '-wal';
  const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
  const integrity = integrityRow?.integrity_check ?? 'unknown';
  return {
    ok: integrity === 'ok',
    integrity,
    tables,
    dbSizeBytes: dbSize,
    userVersion: Number(versionRow?.user_version ?? 0),
    walSizeBytes: walSize,
  };
}

/** 一致性校验：events 里的 in_msg/out_msg 数量应该 >= messages 行数 */
export function consistencyCheck(): { events: number; messages: number; ok: boolean } {
  const conn = getDb();
  const e = conn
    .prepare("SELECT COUNT(*) AS c FROM events WHERE kind IN ('in_msg','out_msg')")
    .get() as { c: number };
  const m = conn.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
  return { events: Number(e.c), messages: Number(m.c), ok: Number(e.c) >= Number(m.c) };
}
