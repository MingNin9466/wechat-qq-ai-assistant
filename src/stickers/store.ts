/**
 * 表情包库：收集群友发的、后台手动加的，统一管理。
 *
 * 目录：data/stickers/（删掉的移到 data/stickers_trash/，不直接抹掉）
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.ts';
import { createLogger } from '../infra/logger.ts';
import { readImageSize } from './image-size.ts';

const log = createLogger('stickers');

const DIR = join(ROOT, 'data', 'stickers');
const TRASH = join(ROOT, 'data', 'stickers_trash');
const MAX_BYTES = 900 * 1024;
const MAX_SIDE = 1000;
const MIN_BYTES = 2500;

export interface StickerInfo {
  name: string;
  bytes: number;
  mtime: number;
  width: number;
  height: number;
  ext: string;
}

function ensure(): void {
  mkdirSync(DIR, { recursive: true });
  mkdirSync(TRASH, { recursive: true });
}

function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

/** 读一张图的真实格式（不靠扩展名） */
export function sniffExt(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
  if (buf[0] === 0x52 && buf[8] === 0x57) return '.webp';
  return '.jpg';
}

/**
 * 把一张图收进图库。
 * @returns 收录的文件名；不收录（太小/太大/重复/不是表情）返回 null
 */
export function collectSticker(srcPath: string, opts: { minBytes?: number } = {}): string | null {
  ensure();
  try {
    if (!existsSync(srcPath)) return null;
    const st = statSync(srcPath);
    if (st.size < (opts.minBytes ?? MIN_BYTES) || st.size > MAX_BYTES) return null;
    const buf = readFileSync(srcPath);
    const ext = sniffExt(buf);
    // 尺寸过滤：表情包通常不超过 1000px，太大多半是封面/截图
    const tmp = join(DIR, `.probe_${Date.now()}.img`);
    writeFileSync(tmp, buf);
    const dim = readImageSize(tmp);
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (!dim || dim.w > MAX_SIDE || dim.h > MAX_SIDE) return null;

    const hash = createHash('md5').update(buf).digest('hex').slice(0, 12);
    const name = `${hash}${ext}`;
    if (existsSync(join(DIR, name))) return name;
    writeFileSync(join(DIR, name), buf);
    log.info('收录表情包', { name, kb: Math.round(buf.length / 1024), from: srcPath.split(/[\\/]/).pop() });
    return name;
  } catch (err) {
    log.debug('收录表情失败', { err: (err as Error).message });
    return null;
  }
}

/** 从本机文件加入图库 */
export function addStickerFile(srcPath: string): { ok: boolean; name?: string; error?: string } {
  ensure();
  if (!existsSync(srcPath)) return { ok: false, error: '文件不存在' };
  const name = collectSticker(srcPath, { minBytes: 500 });
  if (!name) return { ok: false, error: '不是有效图片，或尺寸/体积超限' };
  return { ok: true, name };
}

/** 从 base64 加入图库（后台拖拽/上传用） */
export function addStickerBase64(b64: string): { ok: boolean; name?: string; error?: string } {
  ensure();
  try {
    const buf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (buf.length < 500) return { ok: false, error: '图片太小' };
    const tmp = join(DIR, `.upload_${Date.now()}.img`);
    writeFileSync(tmp, buf);
    const name = collectSticker(tmp, { minBytes: 500 });
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (!name) return { ok: false, error: '尺寸或体积超限' };
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 列图库 */
export function listStickers(): StickerInfo[] {
  ensure();
  const out: StickerInfo[] = [];
  for (const name of readdirSync(DIR)) {
    if (!isImage(name) || name.startsWith('.')) continue;
    const full = join(DIR, name);
    try {
      const st = statSync(full);
      const dim = readImageSize(full);
      out.push({
        name,
        bytes: st.size,
        mtime: st.mtimeMs,
        width: dim?.w ?? 0,
        height: dim?.h ?? 0,
        ext: name.slice(name.lastIndexOf('.')).toLowerCase(),
      });
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 删一张（移到回收站，不硬删） */
export function deleteSticker(name: string): boolean {
  ensure();
  const safe = name.replace(/[\\/]/g, '');
  const full = join(DIR, safe);
  if (!existsSync(full)) return false;
  try {
    renameSync(full, join(TRASH, `${Date.now()}_${safe}`));
    return true;
  } catch {
    try {
      unlinkSync(full);
      return true;
    } catch {
      return false;
    }
  }
}

/** 回收站里的文件 */
export function listTrash(): { name: string; bytes: number }[] {
  ensure();
  return readdirSync(TRASH)
    .map((n) => {
      try {
        return { name: n, bytes: statSync(join(TRASH, n)).size };
      } catch {
        return { name: n, bytes: 0 };
      }
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** 从回收站恢复 */
export function restoreSticker(trashName: string): boolean {
  ensure();
  const src = join(TRASH, trashName);
  if (!existsSync(src)) return false;
  const target = trashName.replace(/^\d+_/, '');
  try {
    copyFileSync(src, join(DIR, target));
    unlinkSync(src);
    return true;
  } catch {
    return false;
  }
}

export function stickerStats(): { count: number; bytes: number; trash: number } {
  const list = listStickers();
  return {
    count: list.length,
    bytes: list.reduce((a, s) => a + s.bytes, 0),
    trash: listTrash().length,
  };
}

export const STICKER_DIR = DIR;
