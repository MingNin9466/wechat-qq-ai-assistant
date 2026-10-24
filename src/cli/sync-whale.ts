/**
 * 养鱼插件（dsh-bili-whale）日记同步：把她的两本日记接进后台「待确认」队列。
 *
 * 数据来源：
 *   ~/.dsh/whale-work/**\/*.md   —— 她刷完视频写的工作目录
 *   ~/.bili-ai/**\/*.md          —— 她的人设与手记（persona.md 除外）
 *
 * 规则：
 *   · 只处理上次同步之后有改动的文件
 *   · 按标题/空行切段，每段太短或太长都跳过
 *   · 一律进 share_candidates（source='whale'），由人在后台点「通过」才进共享记忆
 *   · 权重按内容自动分类（classifyMemoryWeight）
 *
 * 用法：
 *   node src/cli/sync-whale.ts            # 同步
 *   node src/cli/sync-whale.ts --dry      # 只看会进什么，不写库
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureDirs } from '../config.ts';
import { attachLogSink, configureLogger } from '../infra/logger.ts';
import { closeDb, openDb } from '../infra/db.ts';
import { addLogRow, addShareCandidate, kvGet, kvSet } from '../memory/store.ts';
import { classifyMemoryWeight } from '../memory/classify.ts';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const DIRS = [join(DSH_HOME, 'whale-work'), join(homedir(), '.bili-ai')];
const SKIP = new Set(['persona.md']);
const MAX_LEN = 300;
const MIN_LEN = 16;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(md|txt|jsonl)$/i.test(name) && !SKIP.has(name.toLowerCase()) && st.size > 0) out.push(full);
  }
  return out;
}

/** 把一段日记切成条目 */
function splitEntries(text: string): string[] {
  const chunks: string[] = [];
  for (const block of text.split(/\n{2,}|^#{1,6}\s+/m)) {
    const t = block.replace(/^[-*>]\s*/gm, '').replace(/\s+/g, ' ').trim();
    if (t.length < MIN_LEN) continue;
    if (t.length <= MAX_LEN) {
      chunks.push(t);
      continue;
    }
    // 太长就按句号切
    let buf = '';
    for (const seg of t.split(/(?<=[。！？!?])/)) {
      if ((buf + seg).length > MAX_LEN) {
        if (buf.length >= MIN_LEN) chunks.push(buf.trim());
        buf = '';
      }
      buf += seg;
    }
    if (buf.trim().length >= MIN_LEN) chunks.push(buf.trim());
  }
  return chunks;
}

function main(): void {
  ensureDirs();
  configureLogger({ level: 'info', pretty: true });
  openDb();
  attachLogSink(addLogRow);

  const dry = process.argv.includes('--dry');
  const lastAt = Number(kvGet('whale:lastSync') ?? '0');

  const files = DIRS.flatMap((d) => walk(d));
  const fresh = files.filter((f) => {
    try {
      return statSync(f).mtimeMs > lastAt;
    } catch {
      return false;
    }
  });

  console.log(`扫描目录 ${DIRS.length} 个，文件 ${files.length} 个，本次新增/改动 ${fresh.length} 个`);

  let added = 0;

  // 1) 从养鱼配置里读出"她的口味"，直接进候选
  const cfgFile = join(DSH_HOME, 'bili-whale.config.json');
  if (existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as {
        preferences?: { like?: string[]; dislike?: string[] };
        self?: { name?: string };
        owner?: { name?: string };
      };
      const likes = cfg.preferences?.like ?? [];
      const dislikes = cfg.preferences?.dislike ?? [];
      if (likes.length) {
        const content = `小助手在 B 站喜欢看：${likes.join('、')}`;
        const cw = classifyMemoryWeight(content, 'pref', 'diary');
        console.log(`待确认 [养鱼口味·${cw.tag} ${cw.weight.toFixed(2)}] ${content}`);
        if (!dry) addShareCandidate({ chatId: 'whale', content, kind: 'pref', weight: Math.max(cw.weight, 0.75), source: 'whale' });
        added++;
      }
      if (dislikes.length) {
        const content = `小助手在 B 站不喜欢看：${dislikes.join('、')}`;
        const cw = classifyMemoryWeight(content, 'pref', 'diary');
        console.log(`待确认 [养鱼口味·${cw.tag} ${cw.weight.toFixed(2)}] ${content}`);
        if (!dry) addShareCandidate({ chatId: 'whale', content, kind: 'pref', weight: Math.max(cw.weight, 0.75), source: 'whale' });
        added++;
      }
      if (cfg.owner?.name) {
        const content = `小助手管${cfg.owner.name}叫主人`;
        const cw = classifyMemoryWeight(content, 'relation', 'chat');
        console.log(`待确认 [养鱼关系·${cw.tag} ${cw.weight.toFixed(2)}] ${content}`);
        if (!dry) addShareCandidate({ chatId: 'whale', content, kind: 'relation', weight: Math.max(cw.weight, 0.9), source: 'whale' });
        added++;
      }
    } catch {
      /* 配置读不出来就跳过 */
    }
  }

  // 2) 扫日记文件
  for (const f of fresh) {
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const entries = splitEntries(text);
    const rel = f.replace(homedir(), '~');
    console.log(`  ${rel} → ${entries.length} 段`);
    for (const content of entries) {
      const cw = classifyMemoryWeight(content, 'fact', 'diary');
      if (dry) {
        console.log(`    待确认 [养鱼·${cw.tag} ${cw.weight.toFixed(2)}] ${content.slice(0, 50)}`);
      } else {
        addShareCandidate({ chatId: 'whale', content, kind: 'fact', weight: cw.weight, source: 'whale' });
      }
      added++;
    }
  }

  if (!dry) kvSet('whale:lastSync', String(Date.now()));
  console.log(`\n完成：${dry ? '待写入' : '新增'} ${added} 条候选（在后台「记忆 → 待确认的共享记忆」里点通过）`);
  closeDb();
}

main();
