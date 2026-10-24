/**
 * 记忆蒸馏（M3）：
 *   L0 原文  → L1 会话摘要   （每 N 轮 / 隔一段时间自动跑）
 *   L1 摘要  → L2 每日日记   （每晚 23:30）
 *   L2 日记  → L3 长期记忆   （每周，抽取稳定事实）
 *
 * 设计原则：
 *  - 每一层都记录 source_ids，能追溯回原文
 *  - 用 JSON 输出约束格式，避免摘要越写越水
 *  - 失败不影响主流程（全部 try/catch）
 */
import { config } from '../config.ts';
import { getSetting } from '../core/settings.ts';
import { createLogger } from '../infra/logger.ts';
import { chat, type ChatMessage } from '../llm/client.ts';
import { extractJson, truncate } from '../util.ts';
import {
  getDiary,
  getRecentSummaries,
  getUndistilledMessages,
  lastSummaryEnd,
  saveDiary,
  saveMemory,
  saveSharedMemory,
  addShareCandidate,
  saveSummary,
  listMemories,
  type StoredMessage,
} from './store.ts';

const log = createLogger('distill');

/** 把消息压成一段可读文本给模型看 */
function renderMessages(msgs: StoredMessage[]): string {
  return msgs
    .map((m) => {
      const who = m.role === 'assistant' ? 'AI' : m.sender_name || '群友';
      const body = truncate((m.content ?? '').replace(/\s+/g, ' '), 300);
      return `${who}：${body}`;
    })
    .join('\n');
}

/** L0 → L1：把一段对话压成要点 */
export async function distillSession(
  chatId: string,
  opts: { minMessages?: number; force?: boolean } = {},
): Promise<{ ok: boolean; summaryId?: number; usedMessages?: number; reason?: string }> {
  const minMessages = opts.minMessages ?? config.memory.distillEveryTurns;
  const sinceTs = lastSummaryEnd(chatId, 1);
  const msgs = getUndistilledMessages(chatId, sinceTs, 200);

  if (msgs.length < (opts.force ? 1 : minMessages)) {
    return { ok: false, reason: `消息不够（${msgs.length}/${minMessages}）` };
  }

  const body = renderMessages(msgs);
  const prompt = `下面是一段微信群聊记录（按时间顺序）。请把它压缩成「要点摘要」。

要求：
1. 只保留有意义的信息：谁提出了什么、达成了什么结论、有什么待办/约定。
2. 闲聊寒暄可以合并成一句带过。
3. 保留关键人名、数字、时间、链接、专有名词。
4. 用简洁的中文，200~400 字，分条列出。
5. 不要编造记录里没有的内容。

群聊记录：
${body}`;

  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  try {
    const res = await chat({
      messages,
      thinking: false,
      temperature: 0.3,
      maxTokens: 900,
      chatId,
      kind: 'distill',
    });
    const content = res.content.trim();
    if (!content) return { ok: false, reason: '模型返回为空' };

    const id = saveSummary({
      chatId,
      level: 1,
      periodStart: msgs[0]!.ts,
      periodEnd: msgs[msgs.length - 1]!.ts,
      content,
      sourceIds: msgs.map((m) => m.id),
    });
    log.info('会话摘要已生成', { chatId, id, msgs: msgs.length, chars: content.length });
    return { ok: true, summaryId: id, usedMessages: msgs.length };
  } catch (err) {
    log.warn('会话摘要失败', { chatId, err: (err as Error).message });
    return { ok: false, reason: (err as Error).message };
  }
}

/** L1 → L2：生成某天的日记 */
export async function makeDiary(
  chatId: string,
  date: string,
): Promise<{ ok: boolean; reason?: string }> {
  const existing = getDiary(chatId, date);
  if (existing) return { ok: false, reason: '当天日记已存在' };

  const dayStart = new Date(`${date}T00:00:00+08:00`).getTime();
  const dayEnd = dayStart + 86400_000;
  const msgs = getUndistilledMessages(chatId, dayStart, 400).filter((m) => m.ts < dayEnd);
  const summaries = getRecentSummaries(chatId, 1, 20).filter(
    (s) => s.period_end >= dayStart && s.period_end < dayEnd,
  );

  if (msgs.length < 3 && summaries.length === 0) {
    return { ok: false, reason: '当天没有足够内容' };
  }

  const material = [
    summaries.length ? `【当天摘要】\n${summaries.map((s) => s.content).join('\n---\n')}` : '',
    msgs.length ? `【原始消息】\n${renderMessages(msgs.slice(-120))}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const prompt = `请根据下面的群聊材料，写一篇这个群在 ${date} 的日记。

要求：
1. 第一人称、口语化，像自己随手记的，不要写成会议纪要。
2. 结构：今天主要在聊什么 → 有意思的细节/金句 → 有什么待办或约定。
3. 200~400 字，不要编造材料里没有的事。
4. 用 JSON 返回：{"content":"日记正文","topics":["话题1","话题2"],"highlights":["金句"],"todos":["待办"],"mood":"一句话情绪"}

材料：
${material}`;

  try {
    const res = await chat({
      messages: [{ role: 'user', content: prompt }],
      thinking: false,
      temperature: 0.6,
      maxTokens: 1200,
      json: true,
      chatId,
      kind: 'distill',
    });
    const parsed = extractJson<{
      content?: string;
      topics?: string[];
      highlights?: string[];
      todos?: string[];
      mood?: string;
    }>(res.content, {});
    if (!parsed.content) return { ok: false, reason: '模型没给出日记内容' };

    saveDiary({
      chatId,
      date,
      content: parsed.content,
      topics: parsed.topics ?? [],
      highlights: parsed.highlights ?? [],
      todos: parsed.todos ?? [],
      mood: parsed.mood ?? '',
    });
    log.info('日记已生成', { chatId, date, chars: parsed.content.length });
    return { ok: true };
  } catch (err) {
    log.warn('日记生成失败', { chatId, date, err: (err as Error).message });
    return { ok: false, reason: (err as Error).message };
  }
}

/** L2 → L3：从最近的摘要里抽取长期记忆 */
export async function extractMemories(
  chatId: string,
  opts: { limit?: number } = {},
): Promise<{ ok: boolean; added: number; reason?: string }> {
  const summaries = getRecentSummaries(chatId, 1, opts.limit ?? 12);
  if (summaries.length === 0) return { ok: false, added: 0, reason: '还没有摘要' };

  const existing = listMemories(chatId, 60).map((m) => m.content);
  const prompt = `下面是一个微信群的对话摘要。请抽取「值得长期记住」的稳定信息。

只抽这几类（没有就返回空数组）：
- fact：客观事实（谁在做什么、群的性质、固定安排）
- pref：某人的偏好/习惯/雷区
- convention：群里的约定、规矩、暗号
- relation：人与人之间的关系
- todo：明确的待办或截止日期

不要抽：一次性闲聊、情绪化发言、可能过时的临时信息、重复内容。

已有记忆（避免重复）：
${existing.length ? existing.map((c) => '- ' + c).join('\n') : '（空）'}

摘要：
${summaries.map((s) => s.content).join('\n---\n')}

用 JSON 返回数组：[{"content":"一句话事实","kind":"fact","weight":0.8,"subject":"可选，谁"}]
最多 5 条，没有就返回 []。`;

  try {
    const res = await chat({
      messages: [{ role: 'user', content: prompt }],
      thinking: false,
      temperature: 0.2,
      maxTokens: 800,
      json: true,
      chatId,
      kind: 'distill',
    });
    const arr = extractJson<{ content?: string; kind?: string; weight?: number; subject?: string }[]>(
      res.content,
      [],
    );
    let added = 0;
    for (const item of Array.isArray(arr) ? arr : []) {
      const content = (item.content ?? '').trim();
      if (!content || content.length < 4) continue;
      if (existing.some((e) => e === content)) continue;
      // 后台开启"共享记忆"时，同时写一份给所有聊天共用
      const shared = (() => {
        try {
          return getSetting<boolean>('sharedMemory');
        } catch {
          return false;
        }
      })();
      const payload = {
        chatId,
        content,
        kind: (item.kind as 'fact' | 'pref' | 'convention' | 'todo' | 'relation') ?? 'fact',
        subject: item.subject,
        weight: typeof item.weight === 'number' ? Math.min(1, Math.max(0.1, item.weight)) : 0.6,
      };
      saveMemory(payload);
      if (shared) {
        // 不直接共享：先排进候选队列，等人在后台点「通过」
        try {
          addShareCandidate({
            chatId,
            content,
            kind: payload.kind,
            weight: Math.max(0.7, payload.weight),
          });
        } catch {
          /* 候选队列失败不影响主流程 */
        }
      }
      added++;
    }
    log.info('长期记忆抽取完成', { chatId, added, fromSummaries: summaries.length });
    return { ok: true, added };
  } catch (err) {
    log.warn('长期记忆抽取失败', { chatId, err: (err as Error).message });
    return { ok: false, added: 0, reason: (err as Error).message };
  }
}

/** 供调度器用：够量就蒸馏一次（不阻塞主流程） */
export function maybeDistill(chatId: string): void {
  try {
    const threshold = Number(getSetting('distillEveryTurns')) || config.memory.distillEveryTurns;
    const sinceTs = lastSummaryEnd(chatId, 1);
    const msgs = getUndistilledMessages(chatId, sinceTs, threshold + 1);
    if (msgs.length < threshold) return;
    void distillSession(chatId).catch(() => undefined);
  } catch (err) {
    log.debug('触发蒸馏失败（忽略）', { err: (err as Error).message });
  }
}
