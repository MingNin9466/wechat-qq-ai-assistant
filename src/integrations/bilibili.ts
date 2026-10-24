/**
 * B 站链接识别与信息抓取。
 * 用途：群友甩一个 B 站链接时，把视频信息塞进模型上下文，让它能自然地聊这个视频。
 *
 * 不依赖任何第三方库，只用官方公开接口：
 *   GET https://api.bilibili.com/x/web-interface/view?bvid=BVxxxx
 */
import { kvGetJson, kvSetJson } from '../memory/store.ts';
import { createLogger } from '../infra/logger.ts';

const log = createLogger('bilibili');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export interface VideoInfo {
  bvid: string;
  aid?: number;
  title: string;
  author: string;
  duration: number;
  view?: number;
  like?: number;
  pubdate?: number;
  desc?: string;
  pic?: string;
  url: string;
}

const BV_RE = /\bBV[0-9A-Za-z]{10}\b/;
const AV_RE = /\bav(\d{1,12})\b/i;
const SHORT_RE = /https?:\/\/b23\.tv\/[A-Za-z0-9]+/i;
const FULL_RE = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)/i;

/** 取出文字里第一个可下载的视频地址（短链原样返回，yt-dlp 会自己跟随） */
export function extractVideoUrl(text: string): string | null {
  const short = text.match(SHORT_RE);
  if (short) return short[0];
  const full = text.match(FULL_RE);
  if (full) return full[0];
  const bv = text.match(BV_RE);
  if (bv) return `https://www.bilibili.com/video/${bv[0]}`;
  return null;
}

/** 从一段文字里找出 B 站链接（快，不发网络请求） */
export function hasBilibiliLink(text: string): boolean {
  return BV_RE.test(text) || SHORT_RE.test(text) || FULL_RE.test(text) || /bilibili\.com/i.test(text);
}

function fmtDuration(sec: number): string {
  if (!sec || sec < 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtNum(n?: number): string {
  if (!n) return '0';
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + ' 亿';
  if (n >= 10_000) return (n / 10_000).toFixed(1) + ' 万';
  return String(n);
}

/** 短链 → 完整链接（跟随重定向） */
async function expandShort(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(12_000),
    });
    return res.url || url;
  } catch {
    return url;
  }
}

async function fetchByBvid(bvid: string): Promise<VideoInfo | null> {
  const cacheKey = `bili:${bvid}`;
  const cached = kvGetJson<VideoInfo | null>(cacheKey, null);
  if (cached) return cached;
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(12_000),
    });
    const j = (await res.json()) as {
      code?: number;
      message?: string;
      data?: {
        bvid?: string;
        aid?: number;
        title?: string;
        owner?: { name?: string };
        duration?: number;
        stat?: { view?: number; like?: number };
        pubdate?: number;
        desc?: string;
        pic?: string;
      };
    };
    if (j.code !== 0 || !j.data) {
      log.warn('取视频信息失败', { bvid, code: j.code, msg: j.message });
      return null;
    }
    const d = j.data;
    const info: VideoInfo = {
      bvid: d.bvid ?? bvid,
      aid: d.aid,
      title: d.title ?? '(无标题)',
      author: d.owner?.name ?? '未知 UP 主',
      duration: d.duration ?? 0,
      view: d.stat?.view,
      like: d.stat?.like,
      pubdate: d.pubdate,
      desc: (d.desc ?? '').slice(0, 300),
      pic: d.pic,
      url: `https://www.bilibili.com/video/${d.bvid ?? bvid}`,
    };
    kvSetJson(cacheKey, info); // 缓存（kv 无 TTL，同一 BV 信息基本不变）
    return info;
  } catch (err) {
    log.warn('请求 B 站接口异常', { err: (err as Error).message });
    return null;
  }
}

/**
 * 解析文字里的第一个 B 站视频，返回可读描述。
 * 返回 null 表示没有链接或解析失败。
 */
export async function describeBilibili(text: string): Promise<string | null> {
  let target = '';

  const short = text.match(SHORT_RE);
  if (short) {
    target = await expandShort(short[0]);
  }
  if (!target) target = text;

  const bv = target.match(BV_RE);
  if (!bv) return null;

  const info = await fetchByBvid(bv[0]);
  if (!info) return null;

  const date = info.pubdate ? new Date(info.pubdate * 1000).toISOString().slice(0, 10) : '';
  const lines = [
    `【群友分享的 B 站视频】`,
    `标题：${info.title}`,
    `UP 主：${info.author}`,
    `时长：${fmtDuration(info.duration)}`,
    `播放：${fmtNum(info.view)}　点赞：${fmtNum(info.like)}`,
    date ? `发布：${date}` : '',
    info.desc ? `简介：${info.desc}` : '',
    `链接：${info.url}`,
  ].filter(Boolean);
  return lines.join('\n');
}
