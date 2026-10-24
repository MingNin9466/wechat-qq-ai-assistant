/**
 * 结构化日志：
 *  - 控制台（开发时看）
 *  - JSONL 文件（按天滚动，data/logs/YYYY-MM-DD.jsonl）
 *  - SQLite logs 表（管理器可检索，带指纹便于相同错误聚合）
 * 任何一条日志写入失败都不能影响主流程，所以全部 try/catch 吞掉。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { beijingDate, shortHash } from '../util.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export interface LogRow {
  ts: number;
  level: LogLevel;
  module: string;
  msg: string;
  meta?: Record<string, unknown>;
  fingerprint: string;
}

type Sink = (row: LogRow) => void;

let sink: Sink | null = null;
let minLevel: number = LOG_LEVELS[config.log.level] ?? LOG_LEVELS.info;
let pretty = config.env !== 'production';
let logDir = config.storage.logDir;

export function attachLogSink(fn: Sink): void {
  sink = fn;
}

export function configureLogger(opts: { level?: LogLevel; pretty?: boolean; dir?: string }): void {
  if (opts.level) minLevel = LOG_LEVELS[opts.level];
  if (opts.pretty !== undefined) pretty = opts.pretty;
  if (opts.dir) logDir = opts.dir;
}

/** 把消息里的数字、id、时间归一化，让「同一个错误」得到同一个指纹 */
function fingerprintOf(module: string, msg: string): string {
  const normalized = msg
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/g, '<time>')
    .replace(/\b\d{6,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return shortHash(`${module}|${normalized}`);
}

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[97m',
};
const RESET = '\x1b[0m';

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (typeof v === 'string') parts.push(`${k}=${v.length > 120 ? v.slice(0, 117) + '…' : v}`);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) parts.push(`${k}=${String(v)}`);
    else {
      try {
        const s = JSON.stringify(v);
        parts.push(`${k}=${s.length > 200 ? s.slice(0, 197) + '…' : s}`);
      } catch {
        parts.push(`${k}=<unserializable>`);
      }
    }
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function write(level: LogLevel, module: string, msg: string, meta?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] < minLevel) return;
  const now = new Date();
  const row: LogRow = {
    ts: now.getTime(),
    level,
    module,
    msg,
    meta,
    fingerprint: fingerprintOf(module, msg),
  };

  if (pretty) {
    const t = now.toTimeString().slice(0, 8);
    const line = `${COLORS[level]}${t} ${level.toUpperCase().padEnd(5)} ${module.padEnd(12)}${RESET} ${msg}${formatMeta(meta)}`;
    if (level === 'error' || level === 'fatal') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  // 文件
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const file = join(logDir, `${beijingDate(now)}.jsonl`);
    appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch {
    /* 日志失败不影响业务 */
  }

  // 数据库
  if (sink) {
    try {
      sink(row);
    } catch {
      /* 同上 */
    }
  }
}

export interface Logger {
  module: string;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;
  child(module: string): Logger;
}

export function createLogger(module: string): Logger {
  return {
    module,
    debug: (m, meta) => write('debug', module, m, meta),
    info: (m, meta) => write('info', module, m, meta),
    warn: (m, meta) => write('warn', module, m, meta),
    error: (m, meta) => write('error', module, m, meta),
    fatal: (m, meta) => write('fatal', module, m, meta),
    child: (sub) => createLogger(`${module}:${sub}`),
  };
}

export const log = createLogger('app');
