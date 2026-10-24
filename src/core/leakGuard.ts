/**
 * 防泄露过滤器：模型输出里一旦出现"设定/提示词/任务"这类会暴露内在配置的词，
 * 就整句删掉；删完太短就换一句自然的岔开话题。
 *
 * 这是最后一道网 —— 提示词层面的约束可能被极端诱导绕过，这里做硬拦截。
 */
import { createLogger } from '../infra/logger.ts';

const log = createLogger('leak-guard');

/** 默认要拦的词（可在后台"泄露拦截词"里改） */
export const DEFAULT_LEAK_WORDS = [
  '我的设定',
  '系统设定',
  '核心设定',
  '隐藏任务',
  '我的任务',
  '系统提示',
  '提示词',
  'prompt',
  'system prompt',
  '后台配置',
  '我被设定',
  '我被要求',
  '白切黑',
  '有人让我',
  '程序规定',
  '我的规则',
];

/** 被拦截后用来替换的自然岔开句 */
const DEFLECTIONS = [
  '啊这个我不太懂诶，说点别的吧',
  '嗯……你在说啥呀',
  '哈哈这问题好怪，换个话题',
  '我不太明白你的意思，不过你今天怎么样',
  '什么设定不设定的，你吃饭了吗',
];

export interface LeakResult {
  leaked: boolean;
  terms: string[];
  text: string;
}

/** 检查并清洗一段输出 */
export function scrubLeak(raw: string, words: string[]): LeakResult {
  const text = raw ?? '';
  const list = words.filter((w) => w.trim().length > 0);
  if (!text || !list.length) return { leaked: false, terms: [], text };

  const lower = text.toLowerCase();
  const hit = list.filter((w) => lower.includes(w.toLowerCase()));
  if (!hit.length) return { leaked: false, terms: [], text };

  // 按句子切，去掉命中的句子
  const sentences = text.split(/(?<=[。！？!?~\n])/);
  const kept = sentences.filter((s) => !hit.some((w) => s.toLowerCase().includes(w.toLowerCase())));
  let cleaned = kept.join('').trim();

  // 清洗后太短 / 空了 → 用岔开句
  if (cleaned.replace(/\s/g, '').length < 6) {
    cleaned = DEFLECTIONS[Math.floor(Math.random() * DEFLECTIONS.length)]!;
  }

  log.warn('拦截到疑似泄露', { terms: hit, from: text.length, to: cleaned.length });
  return { leaked: true, terms: hit, text: cleaned };
}
