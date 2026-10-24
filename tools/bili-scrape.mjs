/**
 * 从 B 站评论区抓图片表情包（带 WBI 签名，稳定可用）。
 *
 * 用法：node tools/bili-scrape.mjs "关键词1,关键词2" [每个关键词扫几个视频] [最多下载几张]
 *   node tools/bili-scrape.mjs "五条悟表情包,咒术回战表情包,五条悟 梗" 6 60
 *
 * 原理：
 *   1. /x/web-interface/nav 取 img_key/sub_key（用 data/bili_cookies.txt 的登录态）
 *   2. 按 B 站 mixinKey 表签名 → 评论接口才能通过
 *   3. 从评论 richtext / pictures 里取图片链接，下载并过滤（尺寸/大小/去重）
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readImageSize } from './image-size.mjs';

const ROOT = process.cwd();
const OUT = join(ROOT, 'data', 'stickers');
const TMP = join(ROOT, 'data', 'tmp');
const COOKIE_FILE = join(ROOT, 'data', 'bili_cookies.txt');

const KEYWORDS = (process.argv[2] ?? '五条悟表情包,咒术回战 表情包').split(',').map((s) => s.trim()).filter(Boolean);
const VIDEOS_PER_KW = Number(process.argv[3] ?? 6);
const MAX_DOWNLOAD = Number(process.argv[4] ?? 60);

const MAX_BYTES = 600 * 1024;
const MAX_SIDE = 900;

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
};
if (existsSync(COOKIE_FILE)) {
  const raw = readFileSync(COOKIE_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/\r/g, ''))
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 7)
    .map((p) => `${p[5].trim()}=${p[6].trim()}`)
    .join('; ');
  if (raw) UA.Cookie = raw;
}

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];
const md5 = (s) => createHash('md5').update(s).digest('hex');

let wbiKeys = null;
async function getWbiKeys() {
  if (wbiKeys) return wbiKeys;
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: UA });
  const j = await r.json();
  const img = j.data?.wbi_img?.img_url ?? '';
  const sub = j.data?.wbi_img?.sub_url ?? '';
  const pick = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
  wbiKeys = { img: pick(img), sub: pick(sub) };
  return wbiKeys;
}

async function signed(url, params = {}) {
  const { img, sub } = await getWbiKeys();
  const mixin = MIXIN_TAB.map((n) => (img + sub)[n]).join('').slice(0, 32);
  const wts = Math.round(Date.now() / 1000);
  const q = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`);
  q.push(`wts=${wts}`);
  const w_rid = md5(q.join('&') + mixin);
  try {
    const res = await fetch(`${url}?${q.join('&')}&w_rid=${w_rid}`, { headers: UA, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // 被风控/限流时返回的是 HTML，别让整个脚本崩
      return { code: -999, message: `非 JSON 响应（HTTP ${res.status}）` };
    }
  } catch (err) {
    return { code: -998, message: String(err.message) };
  }
}

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { code: -999 };
    }
  } catch {
    return { code: -998 };
  }
}

async function searchVideos(kw) {
  const j = await signed('https://api.bilibili.com/x/web-interface/wbi/search/type', {
    search_type: 'video',
    keyword: kw,
    page: 1,
  });
  if (j.code !== 0) {
    console.log(`  搜索失败 code=${j.code} ${j.message ?? ''}`);
    return [];
  }
  return (j.data?.result ?? []).slice(0, VIDEOS_PER_KW).map((v) => ({
    bvid: v.bvid,
    title: (v.title || '').replace(/<[^>]+>/g, ''),
    review: v.video_review ?? 0,
  }));
}

function collectPics(richtext) {
  const out = [];
  if (!Array.isArray(richtext)) return out;
  for (const seg of richtext) {
    if (!Array.isArray(seg)) continue;
    const val = seg[1];
    if (val && typeof val === 'object') {
      if (val.url) out.push(val.url);
      if (Array.isArray(val.pictures)) for (const p of val.pictures) if (p?.img_src) out.push(p.img_src);
    }
  }
  return out;
}

async function commentsOf(aid) {
  const pics = [];
  for (let pn = 1; pn <= 3; pn++) {
    const j = await signed('https://api.bilibili.com/x/v2/reply/wbi/main', {
      oid: aid,
      type: 1,
      mode: 3,
      plat: 1,
      pagination_str: JSON.stringify({ offset: '' }),
    });
    if (j.code !== 0) {
      // 退回到老接口
      const old = await signed('https://api.bilibili.com/x/v2/reply', { type: 1, oid: aid, pn, ps: 49, sort: 2 });
      if (old.code !== 0) break;
      for (const r of old.data?.replies ?? []) {
        pics.push(...collectPics(r.content?.richtext));
        if (r.content?.pictures) for (const p of r.content.pictures) pics.push(p.img_src);
      }
      continue;
    }
    const replies = j.data?.replies ?? [];
    for (const r of replies) {
      pics.push(...collectPics(r.content?.richtext));
      if (r.content?.pictures) for (const p of r.content.pictures) pics.push(p.img_src);
    }
    const next = j.data?.cursor?.pagination_reply?.next_offset;
    if (!next) break;
  }
  return pics;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  const existing = new Set(readdirSync(OUT).map((f) => f.split('.')[0]));

  let downloaded = 0;
  const tried = new Set();

  // --bvid=BVxxx 模式：只抓这一个视频的评论区（供自主学习调用）
  const onlyBvid = (process.argv.find((a) => a.startsWith('--bvid=')) ?? '').split('=')[1];
  if (onlyBvid) {
    const detail = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${onlyBvid}`);
    const aid = detail.data?.aid;
    if (!aid) {
      console.log('取 aid 失败');
      return;
    }
    const pics = await commentsOf(aid);
    const fresh = pics.filter((u) => /hdslb\.com/.test(u));
    console.log(`评论图 ${pics.length} 张（去重前）`);
    for (const url of fresh) {
      if (downloaded >= MAX_DOWNLOAD) break;
      if (tried.has(url)) continue;
      tried.add(url);
      try {
        const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 4000 || buf.length > MAX_BYTES) continue;
        const tmp = join(TMP, `bi_${Date.now()}.img`);
        writeFileSync(tmp, buf);
        const dim = readImageSize(tmp);
        if (!dim || dim.w > MAX_SIDE || dim.h > MAX_SIDE) continue;
        const hash = md5(buf).slice(0, 12);
        if (existing.has(hash)) continue;
        const ext = url.includes('.gif') ? '.gif' : buf[0] === 0x89 ? '.png' : '.jpg';
        writeFileSync(join(OUT, `${hash}${ext}`), buf);
        existing.add(hash);
        downloaded++;
      } catch {
        /* 跳过 */
      }
    }
    console.log(`完成：从 ${onlyBvid} 评论区新增 ${downloaded} 张，图库共 ${readdirSync(OUT).length} 张`);
    return;
  }

  for (const kw of KEYWORDS) {
    console.log(`\n=== 关键词：${kw}`);
    const videos = await searchVideos(kw);
    console.log(`  找到 ${videos.length} 个视频`);
    for (const v of videos) {
      if (downloaded >= MAX_DOWNLOAD) break;
      const detail = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${v.bvid}`);
      const aid = detail.data?.aid;
      if (!aid) continue;
      const pics = await commentsOf(aid);
      const fresh = pics.filter((u) => !tried.has(u) && /hdslb\.com/.test(u));
      console.log(`  ${v.bvid} 评论图 ${pics.length} 张（新 ${fresh.length}） | ${v.title.slice(0, 24)}`);
      for (const url of fresh) {
        if (downloaded >= MAX_DOWNLOAD) break;
        tried.add(url);
        try {
          const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 4000 || buf.length > MAX_BYTES) continue;
          const tmp = join(TMP, `bi_${Date.now()}.img`);
          writeFileSync(tmp, buf);
          const dim = readImageSize(tmp);
          if (!dim || dim.w > MAX_SIDE || dim.h > MAX_SIDE) continue;
          const hash = md5(buf).slice(0, 12);
          if (existing.has(hash)) continue;
          const ext = url.includes('.gif') ? '.gif' : buf[0] === 0x89 ? '.png' : '.jpg';
          writeFileSync(join(OUT, `${hash}${ext}`), buf);
          existing.add(hash);
          downloaded++;
          if (downloaded % 10 === 0) console.log(`    已下载 ${downloaded} 张…`);
        } catch {
          /* 单张失败跳过 */
        }
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    if (downloaded >= MAX_DOWNLOAD) break;
  }
  console.log(`\n完成：新增 ${downloaded} 张，图库共 ${readdirSync(OUT).length} 张`);
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
