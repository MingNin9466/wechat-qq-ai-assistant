/**
 * 风控之「行为层」：限流、随机延迟、夜间静默。
 * 这里是防封最有效的一环——让机器人看起来像个人，而不是脚本。
 */
import { config } from '../config.ts';
import { getDb } from '../infra/db.ts';
import { createLogger } from '../infra/logger.ts';
import { beijingDate, beijingParts, randInt } from '../util.ts';
import { getSetting } from './settings.ts';

const log = createLogger('ratelimit');

export interface RateDecision {
  ok: boolean;
  reason?: string;
  /** 建议等待毫秒（超限时） */
  retryAfterMs?: number;
}

function parseHM(text: string): { h: number; m: number } | null {
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

/** 是否处于静默时段（支持跨零点，例如 23:30-07:00） */
export function inQuietHours(now: Date = new Date()): boolean {
  if (!getSetting<boolean>('quietEnabled')) return false;
  const start = parseHM(getSetting<string>('quietStart'));
  const end = parseHM(getSetting<string>('quietEnd'));
  if (!start || !end) return false;
  const p = beijingParts(now);
  const cur = p.hour * 60 + p.minute;
  const s = start.h * 60 + start.m;
  const e = end.h * 60 + end.m;
  if (s === e) return false;
  if (s < e) return cur >= s && cur < e;
  return cur >= s || cur < e;
}

/** 模拟打字的随机延迟 */
export function typingDelay(textLength: number): number {
  const base = randInt(getSetting<number>('minDelayMs'), getSetting<number>('maxDelayMs'));
  const extra = Math.min(3000, Math.floor(textLength * 8));
  return base + extra;
}

export function segmentDelay(): number {
  return randInt(
    Math.max(400, Math.floor(config.limits.segmentDelayMs * 0.6)),
    Math.floor(config.limits.segmentDelayMs * 1.6),
  );
}

/**
 * 限流器：内存计数 + 每日计数落库（重启不丢）。
 * 三条线：单群/小时、单群/天、单用户/分钟。
 */
export class RateLimiter {
  private hourHits = new Map<string, number[]>();
  private userHits = new Map<string, number[]>();
  private dayHits = new Map<string, number>();

  private dayKey(chatId: string): string {
    return `rate:day:${chatId}:${beijingDate()}`;
  }

  private loadDay(chatId: string): number {
    const key = this.dayKey(chatId);
    const cached = this.dayHits.get(key);
    if (cached !== undefined) return cached;
    try {
      const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
      const n = Number(row?.value ?? 0);
      this.dayHits.set(key, n);
      return n;
    } catch {
      return 0;
    }
  }

  private saveDay(chatId: string, n: number): void {
    const key = this.dayKey(chatId);
    this.dayHits.set(key, n);
    try {
      getDb()
        .prepare(
          `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, String(n), Date.now());
    } catch {
      /* ignore */
    }
  }

  check(chatId: string, userId: string, ignoreUserLimit = false): RateDecision {
    const now = Date.now();
    const perHour = getSetting<number>('perHour');
    const perDay = getSetting<number>('perDay');
    const perUser = getSetting<number>('perUserPerMin');

    const hour = (this.hourHits.get(chatId) ?? []).filter((t) => now - t < 3600_000);
    this.hourHits.set(chatId, hour);
    if (hour.length >= perHour) {
      const oldest = hour[0] ?? now;
      return {
        ok: false,
        reason: `本群 1 小时回复已达上限 ${perHour} 条`,
        retryAfterMs: Math.max(1000, 3600_000 - (now - oldest)),
      };
    }

    const day = this.loadDay(chatId);
    if (day >= perDay) {
      return { ok: false, reason: `本群今日回复已达上限 ${perDay} 条` };
    }

    const userKey = `${chatId}|${userId}`;
    const user = (this.userHits.get(userKey) ?? []).filter((t) => now - t < 60_000);
    this.userHits.set(userKey, user);
    if (!ignoreUserLimit && user.length >= perUser) {
      return { ok: false, reason: '你问得太快啦，缓一缓再问', retryAfterMs: 20_000 };
    }

    return { ok: true };
  }

  record(chatId: string, userId: string): void {
    const now = Date.now();
    const hour = this.hourHits.get(chatId) ?? [];
    hour.push(now);
    this.hourHits.set(chatId, hour);

    const userKey = `${chatId}|${userId}`;
    const user = this.userHits.get(userKey) ?? [];
    user.push(now);
    this.userHits.set(userKey, user);

    const day = this.loadDay(chatId) + 1;
    this.saveDay(chatId, day);
    log.debug('记账', { chatId: chatId.slice(0, 8), hour: hour.length, day });
  }

  /** 供 /状态 展示 */
  snapshot(chatId: string): { hourUsed: number; dayUsed: number; perHour: number; perDay: number } {
    const now = Date.now();
    const hour = (this.hourHits.get(chatId) ?? []).filter((t) => now - t < 3600_000).length;
    return {
      hourUsed: hour,
      dayUsed: this.loadDay(chatId),
      perHour: config.limits.perHour,
      perDay: config.limits.perDay,
    };
  }
}

export const rateLimiter = new RateLimiter();
