/**
 * 记忆权重自动分类。
 *
 * 目标：不用人工一条条打权重，靠内容特征给一个合理的初始权重，
 * 之后由人工在后台确认时微调。
 *
 * 权重区间约定：
 *   0.95  关系/称呼/隐私/明确约定（最不能丢）
 *   0.85  关于某个人的稳定事实（名字、专业、目标）
 *   0.75  偏好、习惯、态度
 *   0.6   一般观察、群内常见话题
 *   0.45  看过的内容（视频/文章）的感想
 */

const RULES: { re: RegExp; weight: number; tag: string }[] = [
  // 关系与称呼
  { re: /(爸爸|父亲|妈妈|母亲|爷爷|奶奶|哥|姐|弟|妹|老婆|老公|对象|女朋友|男朋友)/, weight: 0.95, tag: '关系' },
  // 绝密 / 隐私
  { re: /(绝密|不可外泄|绝对隐私|不能告诉|别说出去|保密)/, weight: 0.95, tag: '隐私' },
  // 明确约定
  { re: /(约定|说好|以后每|每天|每周|提醒我|记住要|承诺)/, weight: 0.92, tag: '约定' },
  // 关于某个人的稳定事实
  { re: /(叫|名字是|是.{0,4}的人|专业|学校|大学|住在|年龄|岁|工作|职业)/, weight: 0.85, tag: '事实' },
  // 偏好 / 态度
  { re: /(喜欢|讨厌|不喜欢|最烦|最爱|偏爱|习惯|讨厌被|受不了)/, weight: 0.75, tag: '偏好' },
  // 看过的内容
  { re: /(视频|B站|b站|看到|刷到|看了|观后感|UP主|弹幕)/, weight: 0.45, tag: '观感' },
  // 情绪状态（短期）
  { re: /(今天很|好累|开心|难过|焦虑|压力大)/, weight: 0.55, tag: '状态' },
];

export interface ClassifiedMemory {
  weight: number;
  tag: string;
}

/**
 * 根据内容判断权重。
 * @param content 记忆正文
 * @param kind 记忆类型（fact/pref/...）
 * @param source 来源（chat/bili/diary）
 */
export function classifyMemoryWeight(content: string, kind?: string, source?: string): ClassifiedMemory {
  const text = content || '';

  // 视频来源整体偏低，除非里面真的写了关系/隐私
  const base = source === 'bili' || source === 'diary' ? 0.45 : 0.6;

  for (const rule of RULES) {
    if (rule.re.test(text)) {
      // 视频来源只在命中高权重规则时才抬升
      if (base <= 0.5 && rule.weight < 0.85) continue;
      return { weight: rule.weight, tag: rule.tag };
    }
  }

  // 按类型兜底
  if (kind === 'pref') return { weight: 0.7, tag: '偏好' };
  if (kind === 'relation') return { weight: 0.9, tag: '关系' };
  if (kind === 'convention') return { weight: 0.8, tag: '约定' };
  if (kind === 'todo') return { weight: 0.7, tag: '待办' };

  return { weight: base, tag: '一般' };
}
