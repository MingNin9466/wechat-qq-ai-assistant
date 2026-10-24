/**
 * 用识图模型给图库做质检：判断是不是"表情包/梗图"，并标注主角。
 * 非表情包会被移到 data/stickers_rejected/。
 *
 * 用法：node tools/classify-stickers.mjs [--all] [--limit N]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImageSize } from './image-size.mjs';

const ROOT = process.cwd();
const DIR = join(ROOT, 'data', 'stickers');
const REJECTED = join(ROOT, 'data', 'stickers_rejected');
const INDEX = join(DIR, 'index.json');
const ONLY_NEW = !process.argv.includes('--all');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '--limit=999').split('=')[1]);

const { visionChat } = await import('../src/llm/client.ts');

function mimeOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[8] === 0x57) return 'image/webp';
  return 'image/jpeg';
}

async function main() {
  mkdirSync(REJECTED, { recursive: true });
  const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : {};
  const files = readdirSync(DIR).filter((f) => /\.(png|gif|jpe?g|webp)$/i.test(f));
  const todo = files.filter((f) => {
    if (!ONLY_NEW) return true;
    if (index[f]) return false;
    return Date.now() - statSync(join(DIR, f)).mtimeMs < 60 * 60 * 1000;
  });
  console.log(`待质检 ${todo.length} 张（图库共 ${files.length} 张）`);

  let kept = 0;
  let rejected = 0;
  for (const f of todo.slice(0, LIMIT)) {
    const full = join(DIR, f);
    const dim = readImageSize(full);
    if (!dim) continue;
    const buf = readFileSync(full);
    try {
      const ans = await visionChat({
        prompt:
          '这张图是什么？请只输出 JSON：{"sticker":true/false,"subject":"图中人物或主题（10字内）"}。' +
          'sticker=true 指：表情包、梗图、卡通/动漫角色的反应图；' +
          'sticker=false 指：照片、cos照、自拍、截图、壁纸、纯文字长图。',
        images: [{ kind: 'base64', mime: mimeOf(buf), data: buf.toString('base64') }],
        system: '你是图片分类器，只输出 JSON，不要解释。',
        maxTokens: 120,
      });
      const m = ans.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : { sticker: false, subject: '' };
      index[f] = { sticker: Boolean(parsed.sticker), subject: String(parsed.subject ?? '').slice(0, 20) };
      if (parsed.sticker) {
        kept++;
      } else {
        renameSync(full, join(REJECTED, f));
        rejected++;
        console.log(`  ✖ ${f}  ${index[f].subject}`);
      }
    } catch (err) {
      console.log(`  ? ${f} 质检失败：${err.message}`);
    }
  }
  writeFileSync(INDEX, JSON.stringify(index, null, 0), 'utf8');
  console.log(`\n质检完成：保留 ${kept} 张，移出 ${rejected} 张（到 data/stickers_rejected/）`);
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
