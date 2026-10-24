/**
 * 指令系统。所有以 / 开头的消息走这里，不走大模型（快、省钱、可控）。
 * 权限：ADMIN_WXIDS 里的人才能改人格/参数/开关；名单为空时允许第一个声明自己是管理员的人。
 */
import { config } from '../config.ts';
import { createLogger } from '../infra/logger.ts';
import { beijingDate } from '../util.ts';
import { applyPreset, DEFAULT_PERSONA, describePersona, getPersona, PRESETS, resetPersona, setPersona } from './persona.ts';
import { rateLimiter } from './ratelimit.ts';
import {
  deleteMemory,
  getDiary,
  kvGet,
  kvSet,
  listDiary,
  listMemories,
  saveMemory,
  searchDiary,
  searchMemories,
  statsFor,
  usageSince,
} from '../memory/store.ts';
import type { IncomingMessage } from '../adapters/types.ts';

const log = createLogger('commands');

export interface CommandContext {
  msg: IncomingMessage;
  chatId: string;
  admin: boolean;
}

export interface CommandResult {
  handled: boolean;
  reply?: string;
  /** 不需要回复（比如静默记录） */
  silent?: boolean;
}

const HELP_TEXT = `我能干这些事，直接 @我 说就行：
【聊天】随便聊，也可以问我题目、代码、写作
【看图】发张图，让我描述、翻译、做图里的题
【联网】问"今天/最新"的事，我会自己搜
【B站】发 B 站链接，我总结；/B站 关键词 帮你找
【记忆】/记住 xxx、/忘掉 xxx、/记忆 关键词
【日记】/日记 看今天，/日记 2026-10-20 看某天
【设定】/人格 看预设，/人格 温柔学姐 切换
【其他】/状态 /费用 /reset /help

群里默认只有 @我 才回复，免得打扰大家。`;

function norm(text: string): { cmd: string; args: string[]; raw: string } {
  const body = text.slice(config.bot.prefix.length).trim();
  const parts = body.split(/\s+/);
  return { cmd: (parts[0] ?? '').toLowerCase(), args: parts.slice(1), raw: body };
}

export function isCommand(text: string): boolean {
  if (!config.bot.prefix) return false;
  return text.trimStart().startsWith(config.bot.prefix);
}

/** 判断是否管理员；ADMIN_WXIDS 为空时，第一个用 /我是管理员 的人自动获得权限 */
export function isAdmin(senderId: string): boolean {
  if (config.bot.adminWxIds.includes(senderId)) return true;
  const claimed = kvGet('admin:claimed');
  if (!config.bot.adminWxIds.length && claimed === senderId) return true;
  return false;
}

export function handleCommand(ctx: CommandContext): CommandResult {
  const { cmd, args, raw } = norm(ctx.msg.text);
  const needAdmin = (): CommandResult => ({ handled: true, reply: '这个只有管理员能改，找群主吧～' });

  switch (cmd) {
    case 'help':
    case '帮助':
    case '?':
      return { handled: true, reply: HELP_TEXT };

    case 'reset':
    case '重置':
      kvSet(`context_reset:${ctx.chatId}`, String(Date.now()));
      return { handled: true, reply: '好，之前的对话我不再拿来当上下文了。记忆库里的东西还在。' };

    case '状态':
    case 'status': {
      const stats = statsFor(ctx.chatId);
      const rl = rateLimiter.snapshot(ctx.chatId);
      const persona = getPersona(ctx.chatId);
      return {
        handled: true,
        reply: [
          `模型：${config.deepseek.chatModel}（思考模式 ${config.bot.thinking}）`,
          `人格：${persona.name}`,
          `本群：${stats.messages} 条消息 / ${stats.memories} 条记忆 / ${stats.summaries} 条摘要 / ${stats.diary} 篇日记`,
          `限流：本小时 ${rl.hourUsed}/${rl.perHour}，今天 ${rl.dayUsed}/${rl.perDay}`,
          `记忆保留：${config.memory.retentionDays} 天`,
        ].join('\n'),
      };
    }

    case '费用': {
      const since = new Date(beijingDate() + 'T00:00:00+08:00').getTime();
      const u = usageSince(since);
      return {
        handled: true,
        reply: [
          `今日：${u.calls} 次调用，输入 ${u.inTokens} tokens，输出 ${u.outTokens} tokens`,
          `花费约 ¥${u.cost.toFixed(4)}（预算 ¥${config.budget.dailyCny}/天）`,
        ].join('\n'),
      };
    }

    case '人格': {
      if (args.length === 0 || args[0] === '列表') {
        const names = Object.keys(PRESETS);
        const cur = getPersona(ctx.chatId);
        return {
          handled: true,
          reply: `当前：${cur.name}\n可用预设：${names.join('、')}\n用法：/人格 温柔学姐`,
        };
      }
      if (!ctx.admin) return needAdmin();
      const name = args[0]!;
      if (name === '默认') {
        resetPersona(ctx.chatId);
        return { handled: true, reply: '已恢复默认人格。' };
      }
      const p = applyPreset(ctx.chatId, name);
      if (!p) return { handled: true, reply: `没有「${name}」这个预设，可选：${Object.keys(PRESETS).join('、')}` };
      return { handled: true, reply: `好，切换成「${name}」了。` };
    }

    case '设定': {
      if (!ctx.admin) return needAdmin();
      if (args.length === 0) {
        return { handled: true, reply: describePersona(getPersona(ctx.chatId)) };
      }
      const style = raw.replace(/^设定\s*/, '');
      const p = setPersona(ctx.chatId, { style });
      return { handled: true, reply: `记住了。我现在是：${p.style}` };
    }

    case '参数': {
      if (!ctx.admin) return needAdmin();
      const patch: Record<string, number> = {};
      for (const a of args) {
        const m = a.match(/^(温度|长度|maxChars|temperature)=([\d.]+)$/);
        if (!m) continue;
        const v = Number(m[2]);
        if (m[1] === '温度' || m[1] === 'temperature') patch.temperature = Math.min(1.5, Math.max(0, v));
        else patch.maxChars = Math.min(2000, Math.max(80, Math.round(v)));
      }
      if (Object.keys(patch).length === 0) {
        const p = getPersona(ctx.chatId);
        return { handled: true, reply: `当前参数：温度 ${p.temperature}，单条 ≤${p.maxChars} 字\n用法：/参数 温度=0.9 长度=400` };
      }
      setPersona(ctx.chatId, patch);
      return { handled: true, reply: `参数已更新：${JSON.stringify(patch)}` };
    }

    case '记住': {
      const content = raw.replace(/^记住\s*/, '').trim();
      if (!content) return { handled: true, reply: '要记什么？用法：/记住 每周三晚上 8 点开组会' };
      const id = saveMemory({
        chatId: ctx.chatId,
        content,
        pinned: true,
        weight: 1,
        kind: 'fact',
        sourceIds: [],
      });
      return { handled: true, reply: `记下了（#${id}）。以后聊到相关的我会想起来。` };
    }

    case '忘掉':
    case '忘记': {
      const key = args.join(' ').trim();
      if (!key) return { handled: true, reply: '要忘掉什么？给我编号或关键词，比如 /忘掉 3 或 /忘掉 组会' };
      if (/^\d+$/.test(key)) {
        const ok = deleteMemory(Number(key), ctx.chatId);
        return { handled: true, reply: ok ? `已删除记忆 #${key}` : `没找到编号 ${key} 的记忆` };
      }
      const hits = searchMemories(ctx.chatId, key, 5);
      if (hits.length === 0) return { handled: true, reply: `没找到和「${key}」相关的记忆` };
      let deleted = 0;
      for (const h of hits) if (deleteMemory(h.id, ctx.chatId)) deleted++;
      return { handled: true, reply: `删掉了 ${deleted} 条相关记忆。` };
    }

    case '记忆': {
      const key = args.join(' ').trim();
      if (!key) {
        const list = listMemories(ctx.chatId, 15);
        if (list.length === 0) return { handled: true, reply: '还没记住什么。用 /记住 xxx 教我。' };
        return {
          handled: true,
          reply: ['我记得这些：', ...list.map((m) => `#${m.id} ${m.pinned ? '📌' : '·'} ${m.content}`)].join('\n'),
        };
      }
      const hits = searchMemories(ctx.chatId, key, 8);
      if (hits.length === 0) return { handled: true, reply: `没搜到「${key}」` };
      return {
        handled: true,
        reply: [`关于「${key}」：`, ...hits.map((m) => `#${m.id} ${m.content}`)].join('\n'),
      };
    }

    case '日记': {
      if (args[0] === '搜索') {
        const kw = args.slice(1).join(' ');
        if (!kw) return { handled: true, reply: '用法：/日记 搜索 关键词' };
        const found = searchDiary(ctx.chatId, kw, 5);
        if (found.length === 0) return { handled: true, reply: `日记里没找到「${kw}」` };
        return { handled: true, reply: found.map((d) => `【${d.date}】\n${d.content}`).join('\n\n') };
      }
      if (args[0] && /^\d{4}-\d{2}-\d{2}$/.test(args[0])) {
        const d = getDiary(ctx.chatId, args[0]);
        return { handled: true, reply: d ? `【${d.date}】\n${d.content}` : `${args[0]} 那天还没有日记。` };
      }
      if (args.length === 0) {
        const today = getDiary(ctx.chatId, beijingDate());
        if (today) return { handled: true, reply: `【${today.date}】\n${today.content}` };
        const recent = listDiary(ctx.chatId, 3);
        if (recent.length === 0) return { handled: true, reply: '还没有日记。今晚 23:30 我会自动写第一篇。' };
        return {
          handled: true,
          reply: `今天还没写（23:30 自动生成）。最近的日记：\n${recent
            .map((d) => `【${d.date}】${d.content.slice(0, 120)}…`)
            .join('\n')}`,
        };
      }
      return { handled: true, reply: '用法：/日记 或 /日记 2026-10-20 或 /日记 搜索 关键词' };
    }

    case '联网': {
      if (!ctx.admin) return needAdmin();
      const v = (args[0] ?? '').trim();
      if (v === '开') {
        kvSet(`feature:search:${ctx.chatId}`, '1');
        return { handled: true, reply: '本群联网已开。' };
      }
      if (v === '关') {
        kvSet(`feature:search:${ctx.chatId}`, '0');
        return { handled: true, reply: '本群联网已关。' };
      }
      const on = (kvGet(`feature:search:${ctx.chatId}`) ?? '1') !== '0';
      return { handled: true, reply: `本群联网当前：${on ? '开' : '关'}。用法：/联网 开` };
    }

    case '思考': {
      if (!ctx.admin) return needAdmin();
      const v = (args[0] ?? '').trim();
      if (['开', '关', '自动'].includes(v)) {
        const map: Record<string, string> = { 开: 'on', 关: 'off', 自动: 'auto' };
        kvSet(`thinking:${ctx.chatId}`, map[v]!);
        return { handled: true, reply: `本群思考模式：${v}` };
      }
      const cur = kvGet(`thinking:${ctx.chatId}`) ?? 'auto';
      return { handled: true, reply: `本群思考模式：${cur}。用法：/思考 自动|开|关` };
    }

    case '我是管理员': {
      if (config.bot.adminWxIds.length > 0) {
        return { handled: true, reply: '管理员名单已在配置里固定了，改 .env 的 ADMIN_WXIDS。' };
      }
      kvSet('admin:claimed', ctx.msg.senderId);
      log.info('管理员被认领', { sender: ctx.msg.senderName, wxid: ctx.msg.senderId });
      return { handled: true, reply: '好，你是管理员了。以后改人格、改参数都听你的。' };
    }

    case '清除我的数据': {
      const list = searchMemories(ctx.chatId, ctx.msg.senderName || ctx.msg.senderId, 50);
      for (const m of list) deleteMemory(m.id, ctx.chatId);
      return { handled: true, reply: `已删除和你相关的 ${list.length} 条记忆。群里的历史对话仍保留（用于上下文），但不再作为长期记忆。` };
    }

    default:
      return {
        handled: true,
        reply: `没有「${cmd}」这个指令。发 /help 看看我会什么。`,
      };
  }
}

export { HELP_TEXT, DEFAULT_PERSONA };
