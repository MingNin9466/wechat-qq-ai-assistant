/**
 * 从 GitHub 表情包仓库批量下载小图到 data/stickers/。
 * 用法：node tools/fetch-stickers.mjs [数量] [仓库]
 *   默认仓库 getActivity/EmojiPackage（3k★，1951 张小图）
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { readImageSize } from './image-size.mjs';

/** 用 ffmpeg 把 webp 转 png（沙箱不能用管道，输出重定向到文件） */
function convertWebp(src, dst) {
  const FFMPEG = join(process.cwd(), 'tools', 'ffmpeg', 'ffmpeg.exe');
  const logFile = join(process.cwd(), 'data', 'tmp', `conv_${Date.now()}.log`);
  if (!existsSync(FFMPEG)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let fd;
    try {
      fd = openSync(logFile, 'w');
    } catch {
      resolve(false);
      return;
    }
    const child = spawn(FFMPEG, ['-y', '-i', src, dst], { stdio: ['ignore', fd, fd], windowsHide: true });
    child.on('exit', (code) => {
      try {
        closeSync(fd);
        rmSync(logFile, { force: true });
      } catch {
        /* ignore */
      }
      resolve(code === 0 && existsSync(dst));
    });
    child.on('error', () => resolve(false));
  });
}

const COUNT = Number(process.argv[2] ?? 60);
const REPO = process.argv[3] ?? 'getActivity/EmojiPackage';
const FOLDERS = (process.argv[4] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ROOT = process.cwd();
const OUT = join(ROOT, 'data', 'stickers');
const TMP = join(ROOT, 'data', 'tmp');
const MAX_SIZE = 220 * 1024;
const MAX_SIDE = 800;
const UA = { 'User-Agent': 'Mozilla/5.0' };

// 优先挑"可爱/日常"类目录
const PREFER = ['可爱', '萌', '猫', '狗', '柴犬', '兔', '治愈', '动漫', '日常', '好耶', '点赞', '谢谢', '开心'];

function score(path) {
  let s = 0;
  for (const k of PREFER) if (path.includes(k)) s += 10;
  // 文件名太长/太怪的多半是梗图，稍微降权
  if (path.length > 60) s -= 3;
  return s;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  const meta = await (await fetch(`https://api.github.com/repos/${REPO}`, { headers: UA })).json();
  const branch = meta.default_branch ?? 'main';
  const treeRes = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${branch}?recursive=1`, { headers: UA });
  const tree = (await treeRes.json()).tree ?? [];

  const pool = tree
    .filter((x) => x.type === 'blob' && /\.(png|gif|jpe?g|webp)$/i.test(x.path))
    .filter((x) => (FOLDERS.length ? FOLDERS.some((f) => x.path.startsWith(f + '/')) : true))
    .filter((x) => x.size && x.size <= MAX_SIZE && x.size > 3000)
    .map((x) => ({ ...x, score: score(x.path) }))
    .sort((a, b) => b.score - a.score || Math.random() - 0.5);

  console.log(`仓库 ${REPO}：候选 ${pool.length} 张，目标下载 ${COUNT} 张`);

  const existing = new Set(readdirSync(OUT).map((f) => f.split('.')[0]));
  let ok = 0;
  let tried = 0;

  for (const item of pool) {
    if (ok >= COUNT || tried >= COUNT * 3) break;
    tried++;
    const url = `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO}/${branch}/${encodeURI(item.path)}`;
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 3000 || buf.length > MAX_SIZE) continue;
      // 先写临时文件量尺寸，避免把"合集预览网格图"当表情包
      const tmpFile = join(TMP, `probe_${Date.now()}.tmp`);
      writeFileSync(tmpFile, buf);
      const dim = readImageSize(tmpFile);
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
      if (!dim || dim.w > MAX_SIDE || dim.h > MAX_SIDE) continue;
      const hash = createHash('md5').update(buf).digest('hex').slice(0, 12);
      if (existing.has(hash)) continue;
      let ext = extname(item.path).toLowerCase() || '.png';
      let outBuf = buf;
      if (ext === '.webp') {
        const raw = join(TMP, `${hash}.webp`);
        const png = join(TMP, `${hash}.png`);
        writeFileSync(raw, buf);
        if (!(await convertWebp(raw, png))) continue;
        outBuf = readFileSync(png);
        ext = '.png';
        try {
          unlinkSync(raw);
          unlinkSync(png);
        } catch {
          /* ignore */
        }
      }
      writeFileSync(join(OUT, `${hash}${ext}`), outBuf);
      existing.add(hash);
      ok++;
      if (ok % 10 === 0) console.log(`  已下载 ${ok} 张…`);
    } catch {
      /* 单张失败就跳过 */
    }
  }
  console.log(`完成：新增 ${ok} 张，图库共 ${readdirSync(OUT).length} 张`);
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
