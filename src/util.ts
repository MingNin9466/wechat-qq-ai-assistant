/**
 * 通用小工具：时间、随机、哈希、token 估算、文本切分、markdown 清洗。
 * 保持零依赖。
 */
import { createHash } from 'node:crypto';

export const TZ = 'Asia/Shanghai';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** 闭区间随机整数（含两端） */
export function randInt(min: number, max: number): number {
  const a = Math.ceil(Math.min(min, max));
  const b = Math.floor(Math.max(min, max));
  return a + Math.floor(Math.random() * (b - a + 1));
}

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

export function shortHash(text: string): string {
  return sha1(text).slice(0, 12);
}

/** 北京时间的日期字符串 YYYY-MM-DD */
export function beijingDate(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

/** 北京时间 HH:mm */
export function beijingTime(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(d);
}

export interface BeijingParts {
  date: string;
  time: string;
  hour: number;
  minute: number;
  weekday: number; // 0=周日 ... 6=周六
}

export function beijingParts(d: Date = new Date()): BeijingParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${String(hour).padStart(2, '0')}:${get('minute')}`,
    hour,
    minute: Number(get('minute')),
    weekday: wdMap[get('weekday')] ?? 0,
  };
}

/**
 * DeepSeek 高峰时段（北京时间，周一至周五 9:00-12:00、14:00-18:00，法定节假日除外）。
 * 注意：节假日无法离线判断，这里只按工作日近似，宁可高估成本。
 */
export function isPeakHour(d: Date = new Date()): boolean {
  const p = beijingParts(d);
  if (p.weekday === 0 || p.weekday === 6) return false;
  const h = p.hour;
  if (h >= 9 && h < 12) return true;
  if (h >= 14 && h < 18) return true;
  return false;
}

/** 粗略 token 估算：中文约 1 字 ≈ 0.7 token，英文约 4 字符 ≈ 1 token。用于预算裁剪，不追求精确。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
    else if (code >= 0xac00 && code <= 0xd7af) cjk++;
    else if (code >= 0xf900 && code <= 0xfaff) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.75 + other / 3.5);
}

/**
 * 把长文本切成适合微信发送的若干段：
 * 优先在换行、句号、问号、叹号处分段，避免把代码块/句子切碎。
 */
export function splitForWechat(text: string, maxChars: number): string[] {
  const limit = Math.max(80, maxChars);
  const src = text.replace(/\r\n/g, '\n').trim();
  if (src.length <= limit) return src ? [src] : [];

  const chunks: string[] = [];
  let rest = src;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // 从后往前找最佳断点
    let cut = -1;
    for (const sep of ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? ', '; ', '，']) {
      const idx = window.lastIndexOf(sep);
      if (idx > limit * 0.5) {
        cut = idx + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/** 微信里不渲染 markdown，把常见语法转成纯文本，避免出现一堆 ### 和 ** */
export function stripMarkdown(text: string): string {
  let s = text;
  // 代码块：保留内容，去掉围栏
  s = s.replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g, (_m, code: string) => code.trimEnd() + '\n');
  s = s.replace(/`([^`]+)`/g, '$1');
  // 标题
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // 粗体/斜体/删除线
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  // 链接 [text](url) -> text (url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1（$2）');
  // 图片
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 水平线
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, '----------');
  // 引用
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  // 压缩三个以上空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 从模型输出里抠出 JSON 对象（兼容 ```json 包裹 / 前后有解释文字） */
export function extractJson<T>(text: string, fallback: T): T {
  const direct = safeJsonParse<T>(text, fallback);
  if (direct !== fallback) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    const parsed = safeJsonParse<T>(fence[1].trim(), fallback);
    if (parsed !== fallback) return parsed;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = safeJsonParse<T>(text.slice(start, end + 1), fallback);
    if (parsed !== fallback) return parsed;
  }
  return fallback;
}
