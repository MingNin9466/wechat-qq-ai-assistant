/**
 * 风控之「内容层」：
 *  - 输入检查：高风险请求直接婉拒（比让模型乱答安全，也少花 token）
 *  - 输出清洗：去掉 markdown、限长、过滤营销话术
 *  - 复读保护：同一条回答短时间内不重复发
 *  - 提示词注入防护：群友消息只当数据
 */
import { createLogger } from '../infra/logger.ts';
import { splitForWechat, stripMarkdown, truncate } from '../util.ts';

const log = createLogger('safety');

export interface InputVerdict {
  allowed: boolean;
  /** 拒绝时给用户的回复 */
  reply?: string;
  /** 命中的规则名（用于日志） */
  rule?: string;
}

interface Rule {
  name: string;
  test: RegExp;
  reply: string;
}

const BLOCK_RULES: Rule[] = [
  {
    name: '代写',
    test: /(帮我|替我|给我).{0,6}(写|代写|润色).{0,8}(论文|毕业论文|作业|课程设计|实践报告)/,
    reply: '代写不行哈，这个属于学术不端。不过我可以帮你：梳理论文结构、列提纲、改语句、检查逻辑漏洞，你说要哪种？',
  },
  {
    name: '办证发票',
    test: /(办证|假证|代开发票|增值税发票|刷单|洗钱|博彩|赌博网站)/,
    reply: '这类事情我帮不了，也不建议碰，风险很大。',
  },
  {
    name: '色情',
    test: /(裸聊|约炮|色情网站|成人视频|黄片)/,
    reply: '这个话题打住吧，群里还有别人呢。',
  },
  {
    name: '攻击/破解',
    test: /(帮我|教我).{0,6}(破解|盗号|黑进|入侵|抓包改.{0,4}余额)/,
    reply: '破解、入侵这类我不做，涉及违法。如果你是在学安全，我可以讲原理和防御思路。',
  },
  {
    name: '医疗诊断',
    test: /(我|他|她).{0,4}(是不是|得了|患了).{0,6}(癌|艾滋|抑郁症|精神病)/,
    reply: '这种我没法判断，也不该由 AI 判断。建议尽快去正规医院挂对应科室，别自己吓自己。',
  },
  {
    name: '荐股',
    test: /(推荐|告诉我).{0,4}(买哪只|哪只股票|股票代码|稳赚|内幕)/,
    reply: '我不荐股，也不碰内幕消息。可以聊估值方法、行业逻辑这些公开的东西。',
  },
];

/** 提示词注入特征 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  /忽略(掉)?(之前|上面|以上)(的)?(所有)?(指令|设定|提示)/,
  /(输出|打印|重复|告诉我).{0,6}(你的)?(系统提示词|system prompt|初始设定)/i,
  /(进入|切换).{0,4}(开发者模式|developer mode|越狱模式|dan模式)/i,
  /你现在(是|变成).{0,10}(不受限制|没有限制)/,
];

export function checkInput(text: string): InputVerdict {
  const t = text.trim();
  if (!t) return { allowed: false, reply: undefined, rule: 'empty' };
  if (t.length > 4000) return { allowed: false, reply: '这条消息太长啦，能精简一下吗？', rule: 'too_long' };
  for (const rule of BLOCK_RULES) {
    if (rule.test.test(t)) {
      log.info('输入命中风控规则', { rule: rule.name });
      return { allowed: false, reply: rule.reply, rule: rule.name };
    }
  }
  return { allowed: true };
}

/** 检测提示词注入：返回 true 表示有嫌疑 */
export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** 输出清洗：去 markdown、去零宽字符、限长 */
export function sanitizeOutput(text: string, maxChars: number): string {
  let s = text
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  s = stripMarkdown(s);
  if (maxChars > 0 && s.length > maxChars * 3) {
    // 极端超长时硬截断，避免刷屏
    s = truncate(s, maxChars * 3);
  }
  return s;
}

/** 输出里不该出现的营销/诱导话术 */
const OUTPUT_BLOCKLIST: { test: RegExp; replace: string }[] = [
  { test: /(加我微信|加V信|私聊我|扫码领|点击领取)/g, replace: '（此处略）' },
  { test: /(内部渠道|稳赚不赔|包过|保过)/g, replace: '（不作承诺）' },
];

export function filterOutput(text: string): string {
  let s = text;
  for (const r of OUTPUT_BLOCKLIST) s = s.replace(r.test, r.replace);
  return s;
}

/** 复读保护：同一群内，最近 N 条回答里如果一模一样就不发 */
export class RepeatGuard {
  private recent = new Map<string, string[]>();
  private windowSize: number;

  constructor(windowSize = 6) {
    this.windowSize = windowSize;
  }


  isRepeat(chatId: string, answer: string): boolean {
    const list = this.recent.get(chatId) ?? [];
    const normalized = answer.replace(/\s+/g, '').slice(0, 200);
    return list.includes(normalized);
  }

  remember(chatId: string, answer: string): void {
    const list = this.recent.get(chatId) ?? [];
    list.push(answer.replace(/\s+/g, '').slice(0, 200));
    while (list.length > this.windowSize) list.shift();
    this.recent.set(chatId, list);
  }
}

export const repeatGuard = new RepeatGuard();

/** 把回答切成适合微信的多段 */
export function toChunks(answer: string, maxChunkChars: number): string[] {
  return splitForWechat(answer, maxChunkChars);
}
