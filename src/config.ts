/**
 * 配置：从 .env 文件 + 环境变量读取，带默认值与校验。
 * 原则：所有可调项都能用环境变量覆盖，改配置不用改代码。
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（src 的上一级） */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(join(ROOT, '.env'));

function str(key: string, def: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
}

function num(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(key: string, def: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on', 'y'].includes(v.trim().toLowerCase());
}

function list(key: string, def: string[] = []): string[] {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(ROOT, p);
}

export type TriggerMode = 'at' | 'prefix' | 'all' | 'off';
export type ThinkingMode = 'auto' | 'on' | 'off';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface AppConfig {
  root: string;
  env: string;
  deepseek: {
    apiKey: string;
    baseUrl: string;
    chatModel: string;
    reasoningModel: string;
    visionModel: string;
    timeoutMs: number;
    maxRetries: number;
  };
  bot: {
    name: string;
    aliases: string[];
    triggerMode: TriggerMode;
    prefix: string;
    adminWxIds: string[];
    allowedRooms: string[];
    replyMaxChars: number;
    maxChunkChars: number;
    thinking: ThinkingMode;
    systemPrompt: string;
  };
  limits: {
    perHour: number;
    perDay: number;
    perUserPerMin: number;
    minDelayMs: number;
    maxDelayMs: number;
    segmentDelayMs: number;
  };
  quiet: {
    enabled: boolean;
    start: string;
    end: string;
  };
  storage: {
    dataDir: string;
    dbFile: string;
    mediaDir: string;
    logDir: string;
    backupDir: string;
    archiveDir: string;
  };
  memory: {
    retentionDays: number;
    distillEveryTurns: number;
    distillEveryMinutes: number;
    contextTokens: number;
    memoryTokens: number;
    summaryTokens: number;
    historyTokens: number;
  };
  features: {
    vision: boolean;
    search: boolean;
    bilibili: boolean;
    video: boolean;
    voice: boolean;
    diary: boolean;
  };
  budget: {
    dailyCny: number;
  };
  /** 额外扫描微信客户端的目录（doctor 用） */
  wechat: {
    paths: string[];
  };
  log: {
    level: LogLevel;
    db: boolean;
  };
}

const dataDir = abs(str('DATA_DIR', 'data'));

export const config: AppConfig = {
  root: ROOT,
  env: str('NODE_ENV', 'development'),
  deepseek: {
    apiKey: str('DEEPSEEK_API_KEY', ''),
    baseUrl: str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
    chatModel: str('CHAT_MODEL', 'deepseek-flash'),
    reasoningModel: str('REASONING_MODEL', 'deepseek-flash'),
    visionModel: str('VISION_MODEL', 'deepseek-flash'),
    timeoutMs: num('DEEPSEEK_TIMEOUT_MS', 120_000),
    maxRetries: num('DEEPSEEK_MAX_RETRIES', 2),
  },
  bot: {
    name: str('BOT_NAME', '小深'),
    aliases: list('BOT_ALIASES', []),
    triggerMode: str('TRIGGER_MODE', 'at') as TriggerMode,
    prefix: str('BOT_PREFIX', '/'),
    adminWxIds: list('ADMIN_WXIDS', []),
    allowedRooms: list('ALLOWED_ROOMS', []),
    replyMaxChars: num('REPLY_MAX_CHARS', 600),
    maxChunkChars: num('CHUNK_MAX_CHARS', 900),
    thinking: str('THINKING_MODE', 'auto') as ThinkingMode,
    systemPrompt: str('SYSTEM_PROMPT', ''),
  },
  limits: {
    perHour: num('RATE_PER_HOUR', 20),
    perDay: num('RATE_PER_DAY', 120),
    perUserPerMin: num('RATE_PER_USER_PER_MIN', 3),
    minDelayMs: num('MIN_DELAY_MS', 1200),
    maxDelayMs: num('MAX_DELAY_MS', 4500),
    segmentDelayMs: num('SEGMENT_DELAY_MS', 1200),
  },
  quiet: {
    enabled: bool('QUIET_ENABLED', true),
    start: str('QUIET_START', '23:30'),
    end: str('QUIET_END', '07:00'),
  },
  storage: {
    dataDir,
    dbFile: abs(str('DB_FILE', join(dataDir, 'bot.sqlite'))),
    mediaDir: abs(str('MEDIA_DIR', join(dataDir, 'media'))),
    logDir: abs(str('LOG_DIR', join(dataDir, 'logs'))),
    backupDir: abs(str('BACKUP_DIR', join(ROOT, 'backups'))),
    archiveDir: abs(str('ARCHIVE_DIR', join(ROOT, 'archive'))),
  },
  memory: {
    retentionDays: num('MEMORY_RETENTION_DAYS', 90),
    distillEveryTurns: num('DISTILL_EVERY_TURNS', 30),
    distillEveryMinutes: num('DISTILL_EVERY_MINUTES', 120),
    contextTokens: num('CONTEXT_TOKENS', 12000),
    memoryTokens: num('MEMORY_TOKENS', 1200),
    summaryTokens: num('SUMMARY_TOKENS', 1800),
    historyTokens: num('HISTORY_TOKENS', 5000),
  },
  features: {
    vision: bool('FEATURE_VISION', true),
    search: bool('FEATURE_SEARCH', true),
    bilibili: bool('FEATURE_BILIBILI', true),
    video: bool('FEATURE_VIDEO', true),
    voice: bool('FEATURE_VOICE', false),
    diary: bool('FEATURE_DIARY', true),
  },
  budget: {
    dailyCny: num('DAILY_BUDGET_CNY', 5),
  },
  wechat: {
    paths: list('WECHAT_PATHS', ['D:\\WeChatBot', 'C:\\WeChatBot', 'D:\\WeChat']),
  },
  log: {
    level: str('LOG_LEVEL', 'info') as LogLevel,
    db: bool('LOG_TO_DB', true),
  },
};

/** 创建所有需要的目录（幂等） */
export function ensureDirs(): void {
  for (const dir of [
    config.storage.dataDir,
    config.storage.mediaDir,
    config.storage.logDir,
    config.storage.backupDir,
    config.storage.archiveDir,
    dirname(config.storage.dbFile),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 配置体检：返回问题列表（空数组=没问题） */
export function validateConfig(): string[] {
  const problems: string[] = [];
  if (!config.deepseek.apiKey) problems.push('没有配置 DEEPSEEK_API_KEY，无法调用模型');
  if (!['at', 'prefix', 'all', 'off'].includes(config.bot.triggerMode)) {
    problems.push(`TRIGGER_MODE 只能是 at/prefix/all/off，当前是 ${config.bot.triggerMode}`);
  }
  if (!['auto', 'on', 'off'].includes(config.bot.thinking)) {
    problems.push(`THINKING_MODE 只能是 auto/on/off，当前是 ${config.bot.thinking}`);
  }
  if (config.limits.perHour <= 0 || config.limits.perDay <= 0) {
    problems.push('限流参数必须大于 0');
  }
  if (config.memory.retentionDays < 7) {
    problems.push('MEMORY_RETENTION_DAYS 建议至少 30（3 个月=90）');
  }
  return problems;
}
