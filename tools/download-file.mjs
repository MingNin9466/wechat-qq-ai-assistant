/**
 * 断点续传下载器（Node fetch 版）。
 * 本机 curl / Invoke-WebRequest 在沙箱下都下不动，只有 Node fetch 可用，所以自己写一个。
 *
 * 用法：node tools/download-file.mjs <url1,url2,...> <输出路径>
 *   多个 URL 会依次尝试（比如 gh-proxy 镜像 + 直连）。
 */
import { createWriteStream, existsSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const [urlList, out] = process.argv.slice(2);
if (!urlList || !out) {
  console.error('用法: node tools/download-file.mjs <url1,url2> <输出路径>');
  process.exit(1);
}
const urls = urlList.split(',').map((s) => s.trim()).filter(Boolean);
mkdirSync(dirname(out), { recursive: true });
const part = out + '.part';

function human(n) {
  if (n > 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

async function tryDownload(url) {
  let start = existsSync(part) ? statSync(part).size : 0;
  const headers = { 'User-Agent': 'Mozilla/5.0 wechat-bot-setup' };
  if (start > 0) headers.Range = `bytes=${start}-`;

  // 用「空闲超时」而不是「总时长超时」：只要还在传就不掐断，卡住 90 秒才放弃
  const controller = new AbortController();
  let idleTimer = setTimeout(() => controller.abort(), 90_000);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 90_000);
  };

  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
  } catch (err) {
    clearTimeout(idleTimer);
    throw err;
  }
  if (!res.ok && res.status !== 206) {
    clearTimeout(idleTimer);
    throw new Error(`HTTP ${res.status}`);
  }

  // 服务器不支持 Range，但本地有残片 → 从头来
  if (start > 0 && res.status === 200) {
    console.log('  服务器不支持断点续传，从头下载');
    start = 0;
    if (existsSync(part)) unlinkSync(part);
  }

  const total = (() => {
    const cr = res.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/\s*(\d+)/);
      if (m) return Number(m[1]);
    }
    const cl = res.headers.get('content-length');
    return cl ? Number(cl) + start : 0;
  })();

  console.log(`  开始：已有 ${human(start)}${total ? ` / 共 ${human(total)}` : ''}`);
  let done = start;
  let lastReport = Date.now();
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    resetIdle();
    done += chunk.length;
    if (Date.now() - lastReport > 3000) {
      lastReport = Date.now();
      const pct = total ? ((done / total) * 100).toFixed(1) + '%' : '';
      process.stdout.write(`\r  进度 ${human(done)}${total ? ` / ${human(total)} (${pct})` : ''}      `);
    }
  });
  try {
    await pipeline(stream, createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }));
  } finally {
    clearTimeout(idleTimer);
  }
  process.stdout.write('\n');

  const size = statSync(part).size;
  if (total && size !== total) throw new Error(`大小不符：${size} != ${total}`);
  return size;
}

async function main() {
  let lastErr;
  for (let round = 1; round <= 5; round++) {
    for (const url of urls) {
      try {
        console.log(`尝试第 ${round} 轮：${url}`);
        const size = await tryDownload(url);
        if (existsSync(out)) unlinkSync(out);
        // 重命名 .part -> 目标
        const { renameSync } = await import('node:fs');
        renameSync(part, out);
        const hash = await new Promise((resolve, reject) => {
          const h = createHash('sha256');
          createReadStream(out)
            .on('data', (d) => h.update(d))
            .on('end', () => resolve(h.digest('hex')))
            .on('error', reject);
        });
        console.log(`✔ 完成：${out}`);
        console.log(`  大小：${human(size)}`);
        console.log(`  SHA256：${hash}`);
        return;
      } catch (err) {
        lastErr = err;
        console.log(`  失败：${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.error(`✖ 下载失败：${lastErr?.message}`);
  process.exit(1);
}

main();
