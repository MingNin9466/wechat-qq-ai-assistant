/**
 * 桥接：把 DSH 的 B 站人格插件（dsh-bili-humanism）写的「信笺」同步进微信群机器人的记忆库。
 *
 * 数据源：%USERPROFILE%\.dsh\bili-humanism\ledger.sqlite（只读打开）
 *   notes      —— 信笺（body 是 JSON：encounter/facts/inference/next_response…）
 *   readings   —— 读过的视频（bvid/title/body）
 *   human-world.md —— 人格札记（可选，按行取）
 *
 * 用法：
 *   node src/cli/sync-bili.ts                 # 同步到所有已知群
 *   node src/cli/sync-bili.ts --chat 群A    # 只同步到一个群
 *   node src/cli/sync-bili.ts --dry           # 只打印，不写库
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config, ensureDirs } from '../config.ts';
import { closeDb, openDb, getDb } from '../infra/db.ts';
import { attachLogSink, configureLogger } from '../infra/logger.ts';
import { addLogRow, addShareCandidate, searchMemories } from '../memory/store.ts';
import { classifyMemoryWeight } from '../memory/classify.ts';

const LEDGER = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'bili-humanism', 'ledger.sqlite');
const PERSONA_MD = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'bili-humanism', 'human-world.md');

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(name);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v ?? def;
}
const has = (n: string) => process.argv.includes(n);

interface JournalBody {
  encounter?: string;
  facts?: string[] | string;
  author_view?: string;
  inference?: string;
  revision?: string;
  next_response?: string;
  missing?: string;
}

interface Journal {
  id: number;
  readingId: string;
  created: number;
  title: string;
  bvid: string;
  text: string;
}

function pick(obj: unknown, key: string): string {
  if (!obj || typeof obj !== 'object') return '';
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => String(x)).join('；');
  return '';
}

function short(s: string, n = 110): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 读插件的信笺 */
function readJournals(): Journal[] {
  if (!existsSync(LEDGER)) return [];
  const db = new DatabaseSync(LEDGER, { readOnly: true } as never);
  const out: Journal[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT n.id AS id, n.reading_id AS rid, n.created AS created, n.body AS body,
                r.bvid AS bvid, r.body AS rbody
         FROM notes n LEFT JOIN readings r ON r.id = n.reading_id
         ORDER BY n.id ASC`,
      )
      .all() as { id: number; rid: string; created: number; body: string; bvid: string; rbody: string }[];

    for (const row of rows) {
      let body: JournalBody = {};
      let rbody: Record<string, unknown> = {};
      try {
        body = JSON.parse(row.body) as JournalBody;
      } catch {
        /* 纯文本信笺 */
      }
      try {
        rbody = JSON.parse(row.rbody) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      const title = pick(rbody, 'title') || short(row.body ?? '', 40);
      const parts = [
        pick(body, 'encounter'),
        pick(body, 'inference'),
        pick(body, 'next_response'),
      ].filter(Boolean);
      const text = parts.join('；') || short(row.body ?? '', 160);
      out.push({
        id: Number(row.id),
        readingId: String(row.rid ?? ''),
        created: Number(row.created ?? 0),
        title,
        bvid: String(row.bvid ?? ''),
        text,
      });
    }
  } finally {
    db.close();
  }
  return out;
}

/** 人格札记里的条目（按空行分段，取最近的若干段） */
function readPersonaNotes(limit = 20): string[] {
  if (!existsSync(PERSONA_MD)) return [];
  try {
    const raw = readFileSync(PERSONA_MD, 'utf8');
    return raw
      .split(/\n{2,}/)
      .map((s) => s.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 20 && s.length < 400)
      .slice(-limit);
  } catch {
    return [];
  }
}

function main(): void {
  ensureDirs();
  configureLogger({ level: 'info', pretty: true });
  openDb();
  attachLogSink(addLogRow);

  const dry = has('--dry');
  const onlyChat = arg('--chat');
  const chats: string[] = onlyChat
    ? [onlyChat]
    : (getDb()
        .prepare('SELECT DISTINCT chat_id AS c FROM messages ORDER BY ts DESC LIMIT 10')
        .all() as { c: string }[]).map((r) => r.c);

  if (!chats.length) {
    console.log('没有可同步的群（数据库里还没有消息）');
    closeDb();
    return;
  }

  const journals = readJournals();
  const persona = readPersonaNotes();
  console.log(`信笺 ${journals.length} 条，人格札记 ${persona.length} 段，目标群 ${chats.length} 个`);

  if (!journals.length && !persona.length) {
    console.log('插件还没写过信笺，先让它读一个视频吧。');
    closeDb();
    return;
  }

  let added = 0;
  // 每条信笺只产生一条候选（通过后进全局共享），不按会话复制
  for (const j of journals) {
    const date = j.created ? new Date(j.created).toISOString().slice(0, 10) : '';
    const content = `B站信笺${date ? `（${date}）` : ''}《${short(j.title, 30)}》：${short(j.text, 120)}`;
    const cw = classifyMemoryWeight(content, 'fact', 'bili');
    console.log(`待确认 [B站·${cw.tag} 权重${cw.weight.toFixed(2)}] ${content.slice(0, 60)}`);
    if (!dry) addShareCandidate({ chatId: 'bili', content, kind: 'fact', weight: cw.weight, source: 'bili' });
    added++;
  }
  for (const p of persona) {
    const content = `人格札记：${short(p, 140)}`;
    const cw2 = classifyMemoryWeight(content, 'pref', 'diary');
    console.log(`待确认 [日记·${cw2.tag} 权重${cw2.weight.toFixed(2)}] ${content.slice(0, 60)}`);
    if (!dry) addShareCandidate({ chatId: 'bili', content, kind: 'pref', weight: cw2.weight, source: 'diary' });
    added++;
  }

  console.log(`\n完成：${dry ? '待写入' : '新增'} ${added} 条记忆`);
  closeDb();
}

function dup(chat: string, content: string): boolean {
  const head = content.slice(0, 24);
  return searchMemories(chat, head, 3).some((m) => m.content.startsWith(content.slice(0, 24)));
}

void config;
main();
