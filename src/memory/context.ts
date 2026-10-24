/**
 * 上下文装配：把「人设 + 记忆 + 摘要 + 近期原文」按 token 预算拼成 messages。
 * 原则：不是把所有东西都塞进去，而是把该记的检索进来。
 *  ① 固定注入 pinned 长期记忆
 *  ② 按当前问题检索相关记忆/摘要（跨 90 天）
 *  ③ 最近几天摘要
 *  ④ 最近若干轮原文
 */
import { config } from '../config.ts';
import { buildSystemPrompt, getPersona, type Persona } from '../core/persona.ts';
import type { ChatMessage } from '../llm/client.ts';
import { estimateTokens } from '../util.ts';
import { getPinnedMemories, getRecentMessages, getRecentSummaries, kvGet, searchMemories, searchSummaries, type StoredMemory } from './store.ts';

export interface BuildContextInput {
  chatId: string;
  chatName?: string;
  query: string;
  /** 是否允许联网（影响 system prompt 措辞） */
  searchEnabled: boolean;
}

export interface BuiltContext {
  messages: ChatMessage[];
  persona: Persona;
  debug: {
    pinned: number;
    memoryHits: number;
    summaryHits: number;
    historyCount: number;
    systemTokens: number;
    historyTokens: number;
  };
}

function fitByTokens(items: string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  // 从后往前保留（越新越重要）
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    const t = estimateTokens(item);
    if (used + t > budget) break;
    kept.unshift(item);
    used += t;
  }
  return kept;
}

function memoryLine(m: StoredMemory): string {
  const subject = m.subject ? `${m.subject}：` : '';
  const pin = m.pinned ? '📌' : '';
  return `${pin}${subject}${m.content}`;
}

export function buildContext(input: BuildContextInput): BuiltContext {
  const persona = getPersona(input.chatId);

  // ① pinned 记忆
  const pinned = getPinnedMemories(input.chatId, 20);

  // ② 检索相关记忆 / 摘要
  const searchedMemories = searchMemories(input.chatId, input.query, 8);
  const searchedSummaries = searchSummaries(input.chatId, input.query, 4);

  // 去重（pinned 优先）
  const seen = new Set<number>();
  const memoryLines: string[] = [];
  for (const m of [...pinned, ...searchedMemories]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    memoryLines.push(memoryLine(m));
  }
  const memoryBlock = fitByTokens(memoryLines, config.memory.memoryTokens).join('\n');

  // ③ 最近的摘要（L1 会话摘要）；如果 /reset 过，就不再注入旧摘要
  const resetTs = Number(kvGet(`context_reset:${input.chatId}`) ?? 0);
  const recentSummaries = resetTs > 0 ? [] : getRecentSummaries(input.chatId, 1, 3);
  const summaryItems = [
    ...(resetTs > 0 ? [] : searchedSummaries.map((s) => `（${new Date(s.period_end).toLocaleDateString('zh-CN')}）${s.content}`)),
    ...recentSummaries.map((s) => `（${new Date(s.period_end).toLocaleDateString('zh-CN')}）${s.content}`),
  ];
  const summaryBlock = fitByTokens(summaryItems, config.memory.summaryTokens).join('\n');

  const system = buildSystemPrompt(persona, {
    chatId: input.chatId,
    chatName: input.chatName,
    memoryBlock,
    summaryBlock,
    searchEnabled: input.searchEnabled,
  });

  // ④ 近期原文（/reset 之后只取重置点之后的消息）
  const recent = getRecentMessages(input.chatId, 30, resetTs > 0 ? resetTs : undefined);
  const historyItems: ChatMessage[] = recent.map((m) => {
    const prefix = m.role === 'user' && input.chatName ? `${m.sender_name ?? '群友'}：` : '';
    return {
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: `${prefix}${m.content ?? ''}`,
    } as ChatMessage;
  });

  // 按 token 预算从旧到新裁掉
  let historyTokens = historyItems.reduce((sum, m) => sum + estimateTokens(String(m.content)), 0);
  while (historyTokens > config.memory.historyTokens && historyItems.length > 2) {
    const removed = historyItems.shift();
    if (!removed) break;
    historyTokens -= estimateTokens(String(removed.content));
  }

  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...historyItems];

  return {
    messages,
    persona,
    debug: {
      pinned: pinned.length,
      memoryHits: searchedMemories.length,
      summaryHits: searchedSummaries.length,
      historyCount: historyItems.length,
      systemTokens: estimateTokens(system),
      historyTokens,
    },
  };
}
