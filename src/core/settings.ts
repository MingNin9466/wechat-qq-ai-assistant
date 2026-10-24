/**
 * 运行时可改的设定（热生效，不用重启）。
 *
 * 存储：kv 表里的 `setting:<key>`；没有覆盖值时回落到 config.ts 的默认值。
 * 后台面板读写这里，业务代码通过 getSetting() 取当前生效值。
 */
import { config } from '../config.ts';
import { createLogger } from '../infra/logger.ts';
import { kvDelete, kvGet, kvSet } from '../memory/store.ts';

const log = createLogger('settings');

export type SettingType = 'string' | 'number' | 'boolean' | 'enum';

export interface SettingDef {
  key: string;
  label: string;
  group: string;
  type: SettingType;
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  hint?: string;
  /** 只读：需要在桥接/启动参数里改，改完要重启 */
  readonly?: boolean;
}

export const SETTINGS: SettingDef[] = [
  // ---- 回复行为 ----
  {
    key: 'triggerMode',
    label: '触发模式',
    group: '回复行为',
    type: 'enum',
    options: ['at', 'prefix', 'all', 'off'],
    default: config.bot.triggerMode,
    hint: 'at=只有被@才回；prefix=以 / 开头；all=全量回复（容易刷屏）；off=关闭',
  },
  {
    key: 'replyMaxChars',
    label: '单条回复字数上限',
    group: '回复行为',
    type: 'number',
    default: config.bot.replyMaxChars,
    min: 50,
    max: 3000,
    step: 50,
    hint: '软上限，超长会按标点拆成多条',
  },
  {
    key: 'maxChunkChars',
    label: '分段长度',
    group: '回复行为',
    type: 'number',
    default: config.bot.maxChunkChars,
    min: 200,
    max: 2000,
    step: 50,
  },
  {
    key: 'thinkingMode',
    label: '思考模式',
    group: '回复行为',
    type: 'enum',
    options: ['auto', 'on', 'off'],
    default: config.bot.thinking,
    hint: 'auto=数学/代码题才开；on=总是开（慢、贵）；off=总是关',
  },

  // ---- 限流 ----
  { key: 'perHour', label: '每群每小时上限', group: '限流', type: 'number', default: config.limits.perHour, min: 1, max: 200 },
  { key: 'perDay', label: '每群每天上限', group: '限流', type: 'number', default: config.limits.perDay, min: 1, max: 2000 },
  { key: 'perUserPerMin', label: '每人每分钟上限', group: '限流', type: 'number', default: config.limits.perUserPerMin, min: 1, max: 20 },
  { key: 'minDelayMs', label: '最短延迟(ms)', group: '限流', type: 'number', default: config.limits.minDelayMs, min: 0, max: 20000, step: 100 },
  { key: 'maxDelayMs', label: '最长延迟(ms)', group: '限流', type: 'number', default: config.limits.maxDelayMs, min: 0, max: 30000, step: 100 },

  // ---- 静默时段 ----
  { key: 'quietEnabled', label: '启用夜间静默', group: '静默时段', type: 'boolean', default: config.quiet.enabled },
  { key: 'quietStart', label: '开始时间', group: '静默时段', type: 'string', default: config.quiet.start, hint: 'HH:mm，例如 23:30' },
  { key: 'quietEnd', label: '结束时间', group: '静默时段', type: 'string', default: config.quiet.end },

  // ---- 功能开关 ----
  { key: 'featureSearch', label: '联网搜索', group: '功能开关', type: 'boolean', default: config.features.search },
  { key: 'featureVision', label: '看图', group: '功能开关', type: 'boolean', default: config.features.vision },
  { key: 'featureBilibili', label: 'B 站', group: '功能开关', type: 'boolean', default: config.features.bilibili },
  { key: 'featureDiary', label: '日记', group: '功能开关', type: 'boolean', default: config.features.diary },
  { key: 'featureVideo', label: '视频理解', group: '功能开关', type: 'boolean', default: config.features.video },

  // ---- 语音 ----
  {
    key: 'featureVoice',
    label: '语音回复',
    group: '语音',
    type: 'boolean',
    default: true,
    hint: '按概率把回复也合成一条语音发出来（需要该群开独立窗口）',
  },
  {
    key: 'voiceName',
    label: '音色',
    group: '语音',
    type: 'enum',
    options: ['zh-CN-XiaoyiNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaobeiNeural', 'zh-CN-YunxiNeural'],
    default: 'zh-CN-XiaoyiNeural',
    hint: 'Xiaoyi=少女活泼 / Xiaoxiao=温柔 / Xiaobei=东北味 / Yunxi=男声',
  },
  {
    key: 'voiceChance',
    label: '语音概率（%）',
    group: '语音',
    type: 'number',
    default: 15,
    min: 0,
    max: 100,
    step: 5,
    hint: '每次回复后额外发一条语音的概率；0 = 不发',
  },
  {
    key: 'voiceEngine',
    label: '语音引擎',
    group: '语音',
    type: 'enum',
    options: ['doubao', 'edge'],
    default: 'doubao',
    hint: 'doubao=豆包（自然、支持复刻）；edge=微软（免费但机械）',
  },
  {
    key: 'doubaoVoiceId',
    label: '豆包音色 ID',
    group: '语音',
    type: 'string',
    default: '<YOUR_VOICE_ID>',
    hint: '复刻音色 ID（S_ 开头），或内置音色名 zh_female_sajiaoxuemei_uranus_bigtts',
  },
  {
    key: 'leakFilterOn',
    label: '泄露拦截',
    group: '安全',
    type: 'boolean',
    default: true,
    hint: '回复里出现"设定/提示词/任务"这类会暴露内在配置的词时，自动删掉那句话',
  },
  {
    key: 'leakWords',
    label: '泄露拦截词',
    group: '安全',
    type: 'string',
    default: '',
    hint: '留空用内置词表；也可以自己填（逗号分隔），会替换默认表',
  },
  {
    key: 'autoCollectStickers',
    label: '自动收集群友表情包',
    group: '表情包',
    type: 'boolean',
    default: true,
    hint: '群友发的表情包自动收进自己的图库，之后回复时随机用',
  },
  {
    key: 'triggerKeywords',
    label: '关键词触发',
    group: '回复行为',
    type: 'string',
    default: '',
    hint: '逗号分隔。就算没 @ 它，消息里含这些词也会回，例如：小助手,小深,在吗',
  },
  {
    key: 'antiRepeatOn',
    label: '防刷屏',
    group: '回复行为',
    type: 'boolean',
    default: true,
    hint: '同一个人短时间内重复发几乎一样的消息时，不重复回复',
  },
  {
    key: 'sharedMemory',
    label: '共享记忆（所有聊天通用）',
    group: '记忆',
    type: 'boolean',
    default: true,
    hint: '打开后，从对话里提炼的关键信息会自动写一份给所有群和私聊共用；关掉则各自独立',
  },
  {
    key: 'autoExtract',
    label: '定期提炼关键信息',
    group: '记忆',
    type: 'boolean',
    default: true,
    hint: '每小时自动从各群的对话摘要里提炼值得长期记住的信息',
  },
  {
    key: 'doubaoResource',
    label: '豆包资源标识',
    group: '语音',
    type: 'string',
    default: 'volc.seedicl.default',
    hint: '复刻音色 volc.seedicl.default；内置音色 seed-tts-2.0',
  },

  // ---- 随机插话 ----
  {
    key: 'featureSticker',
    label: '发表情包',
    group: '表情包',
    type: 'boolean',
    default: true,
    hint: '回复时按概率补一张表情包（需要该群开了独立窗口）',
  },
  {
    key: 'stickerReplyChance',
    label: '发表情包概率（%）',
    group: '表情包',
    type: 'number',
    default: 30,
    min: 0,
    max: 100,
    step: 5,
    hint: '每次回复后附一张表情包的概率；0 = 从不发',
  },
  {
    key: 'distillEveryTurns',
    label: '每多少条消息压一次摘要',
    group: '记忆',
    type: 'number',
    default: config.memory.distillEveryTurns,
    min: 5,
    max: 200,
    step: 5,
    hint: '攒够这么多条消息就自动做一次会话蒸馏（越小越勤、越费钱）',
  },
  {
    key: 'randomChatChance',
    label: '随机插话概率（%）',
    group: '随机插话',
    type: 'number',
    default: 5,
    min: 0,
    max: 100,
    step: 1,
    hint: '群友闲聊时主动搭话的概率；0 = 关闭。只对有信息量的文字生效',
  },
  {
    key: 'randomChatCooldownMin',
    label: '随机插话冷却（分钟）',
    group: '随机插话',
    type: 'number',
    default: 15,
    min: 1,
    max: 360,
    step: 1,
    hint: '同一个群两次随机插话的最小间隔，防止刷屏',
  },
  {
    key: 'imageChimeChance',
    label: '看图插话概率（%）',
    group: '随机插话',
    type: 'number',
    default: 25,
    min: 0,
    max: 100,
    step: 5,
    hint: '群友发图片/表情包（没 @ 你）时，主动接一句的概率；0 = 不插话',
  },

  // ---- 暂停 ----
  {
    key: 'paused',
    label: '手动暂停',
    group: '暂停',
    type: 'boolean',
    default: false,
    hint: '打开后机器人完全不回复（你打游戏/开会时用）',
  },
  {
    key: 'pauseWhenFullscreen',
    label: '全屏时自动暂停',
    group: '暂停',
    type: 'boolean',
    default: true,
    hint: '检测到全屏程序（游戏/视频）在前台时自动不回复，防止抢窗口、最小化游戏',
  },

  // ---- 预算 ----
  {
    key: 'dailyBudgetCny',
    label: '每日预算(元)',
    group: '预算',
    type: 'number',
    default: config.budget.dailyCny,
    min: 0,
    max: 200,
    step: 1,
    hint: '超了就停止回答；0 表示不限',
  },

  // ---- 只读信息 ----
  { key: 'botName', label: '机器人昵称', group: '其它', type: 'string', default: config.bot.name, readonly: true, hint: '在启动参数 --self-name 里设置，改完要重启桥接' },
  { key: 'chatModel', label: '对话模型', group: '其它', type: 'string', default: config.deepseek.chatModel, readonly: true, hint: '在 .env 里改' },
  { key: 'retentionDays', label: '记忆保留天数', group: '其它', type: 'number', default: config.memory.retentionDays, readonly: true },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

function kvKey(key: string): string {
  return `setting:${key}`;
}

/** 取当前生效值：kv 覆盖优先，否则默认值 */
export function getSetting<T = string | number | boolean>(key: string): T {
  const def = BY_KEY.get(key);
  const raw = kvGet(kvKey(key));
  if (raw !== null) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      /* 坏数据回落默认 */
    }
  }
  return (def ? def.default : undefined) as T;
}

export interface SetResult {
  ok: boolean;
  value?: string | number | boolean;
  error?: string;
}

/** 写设定（带类型与范围校验） */
export function setSetting(key: string, value: unknown): SetResult {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: `未知设定项：${key}` };
  if (def.readonly) return { ok: false, error: `${def.label} 是只读项，需要改配置文件并重启` };

  let normalized: string | number | boolean;
  if (def.type === 'boolean') {
    normalized = value === true || value === 'true' || value === 1 || value === '1';
  } else if (def.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: `${def.label} 必须是数字` };
    let v = n;
    if (def.min !== undefined) v = Math.max(def.min, v);
    if (def.max !== undefined) v = Math.min(def.max, v);
    normalized = v;
  } else if (def.type === 'enum') {
    const s = String(value);
    if (def.options && !def.options.includes(s)) {
      return { ok: false, error: `${def.label} 只能是 ${def.options.join(' / ')}` };
    }
    normalized = s;
  } else {
    normalized = String(value);
    if (normalized.length > 200) return { ok: false, error: '内容太长' };
  }

  kvSet(kvKey(key), JSON.stringify(normalized));
  log.info('设定已更新', { key, value: normalized });
  return { ok: true, value: normalized };
}

export function resetSetting(key: string): SetResult {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: `未知设定项：${key}` };
  kvDelete(kvKey(key));
  return { ok: true, value: def.default };
}

export interface SettingView extends SettingDef {
  value: string | number | boolean;
  overridden: boolean;
}

export function listSettings(): SettingView[] {
  return SETTINGS.map((s) => ({
    ...s,
    value: getSetting(s.key),
    overridden: kvGet(kvKey(s.key)) !== null,
  }));
}
