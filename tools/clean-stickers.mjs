/**
 * 清理图库：删掉尺寸过大（像"合集预览网格图"）或过重的文件。
 * 用法：node tools/clean-stickers.mjs [--dry]
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readImageSize } from './image-size.mjs';

const ROOT = process.cwd();
const DIR = join(ROOT, 'data', 'stickers');
const DRY = process.argv.includes('--dry');

const MAX_SIDE = 800;
const MAX_BYTES = 600 * 1024;

function main() {
  if (!existsSync(DIR)) {
    console.error('图库目录不存在:', DIR);
    process.exit(1);
  }
  const files = readdirSync(DIR).filter((f) => /\.(png|gif|jpe?g|webp)$/i.test(f));
  let removed = 0;
  let kept = 0;
  for (const f of files) {
    const full = join(DIR, f);
    const size = statSync(full).size;
    const dim = readImageSize(full);
    const w = dim?.w ?? 0;
    const h = dim?.h ?? 0;
    const bad = !w || !h || w > MAX_SIDE || h > MAX_SIDE || size > MAX_BYTES;
    if (bad) {
      console.log(`✖ ${f}  ${w}x${h}  ${Math.round(size / 1024)}KB`);
      if (!DRY) unlinkSync(full);
      removed++;
    } else {
      kept++;
    }
  }
  console.log(`\n清理完成：保留 ${kept} 张，${DRY ? '待删' : '已删'} ${removed} 张`);
}

main();
