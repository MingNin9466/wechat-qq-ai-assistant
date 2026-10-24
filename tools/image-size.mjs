/**
 * 纯 JS 读图片尺寸（不调用 ffprobe —— 沙箱里管道子进程会 EPERM）。
 * 支持 PNG / GIF / JPEG / WEBP。
 */
import { readFileSync } from 'node:fs';

export function readImageSize(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  if (buf.length < 24) return null;

  // PNG: 89 50 4E 47 ... IHDR at 16/20
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF: GIF8, LE16 at 6/8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // WEBP: RIFF....WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X' && buf.length >= 30) {
      return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    if (fmt === 'VP8 ' && buf.length >= 30) {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
  }
  // JPEG: 扫描 SOF 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}
