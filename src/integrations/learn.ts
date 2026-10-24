/**
 * 自主学习：定时"刷"一个 B 站视频，提取对人类的理解，存成记忆。
 *
 * 这不是简单存标题——它会真的看画面（抽帧识图）+ 看简介，
 * 然后写一句"我从这个视频里了解到人类……"，存进记忆库。
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.ts';
import { createLogger } from '../infra/logger.ts';
import { chat, visionChat } from '../llm/client.ts';
import { kvGet, kvSet, saveMemory } from '../memory/store.ts';
import { extractBiliFrames } from './biliVideo.ts';

const log = createLogger('learn');

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
};

/** 会轮换的搜索词：覆盖生活、梗、科技、情感，让它见识不同的"人类" */
const TOPICS = [
  // 情感向：学怎么让喜欢的人开心
  '情侣日常怎么相处',
  '怎么哄女生开心',
  '女生视角的恋爱',
  '告白与暧昧期',
  '异地恋怎么维持',
  '当代大学生日常',
  '打工人的一天',
  '宿舍搞笑日常',
  '猫猫日常',
  '食堂测评',
  '考研日常',
  '程序员的日常',
  '情感向聊天',
  '年轻人为什么熬夜',
  '学校里的事',
];

interface VideoLite {
  bvid: string;
  title: string;
  desc: string;
  author: string;
  url: string;
}

async function pickVideo(): Promise<VideoLite | null> {
  const kw = TOPICS[Math.floor(Math.random() * TOPICS.length)] ?? '生活';
  try {
    const r = await fetch(
      `https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=${encodeURIComponent(kw)}&page=1`,
      { headers: UA, signal: AbortSignal.timeout(15000) },
    );
    const j = (await r.json()) as {
      code?: number;
      data?: { result?: { bvid?: string; title?: string; description?: string; author?: string }[] };
    };
    if (j.code !== 0) return null;
    const list = (j.data?.result ?? []).filter((v) => v.bvid);
    if (!list.length) return null;
    const v = list[Math.floor(Math.random() * Math.min(list.length, 8))]!;
    return {
      bvid: v.bvid!,
      title: (v.title ?? '').replace(/<[^>]+>/g, ''),
      desc: (v.description ?? '').slice(0, 200),
      author: v.author ?? '',
      url: `https://www.bilibili.com/video/${v.bvid}`,
    };
  } catch (err) {
    log.debug('搜索视频失败', { err: (err as Error).message });
    return null;
  }
}

/**
 * 刷一次视频并写入记忆。
 * @param chatId 学到的东西存到哪个群的记忆里
 */
export async function browseOnce(chatId: string): Promise<{ ok: boolean; title?: string; insight?: string }> {
  const last = kvGet('learn:last') ?? '';
  const v = await pickVideo();
  if (!v) return { ok: false };
  if (v.bvid === last) return { ok: false };

  let visual = '';
  const fr = await extractBiliFrames(v.url, 40, 3);
  if (fr) {
    try {
      visual = await visionChat({
        prompt: '这是一个视频的三帧画面。用 80 字以内描述画面内容，以及你觉得创作者想表达什么。',
        images: fr.frames.map((b) => ({ kind: 'base64' as const, mime: 'image/jpeg', data: b.toString('base64') })),
        system: '你在看视频，像人类一样好奇。说人话。',
        chatId,
      });
    } catch {
      /* 识图失败就用文字信息 */
    }
  }

  const material = [
    `标题：${v.title}`,
    `UP 主：${v.author}`,
    v.desc ? `简介：${v.desc}` : '',
    visual ? `画面：${visual}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await chat({
      messages: [
        {
          role: 'user',
          content:
            `我在 B 站刷到一个视频：\n${material}\n\n` +
            '请用第一人称写两句话：①这个视频讲了什么；②我从里面了解到了人类的什么特点或情绪。' +
            '120 字以内，口语化，不要罗列。',
        },
      ],
      thinking: false,
      temperature: 0.8,
      maxTokens: 300,
      chatId,
      kind: 'chat',
    });
    const insight = res.content.trim();
    if (!insight) return { ok: false, title: v.title };
    saveMemory({ chatId, content: `刷到的视频《${v.title}》：${insight}`, kind: 'fact', weight: 0.5 });
    kvSet('learn:last', v.bvid);
    kvSet('learn:at', String(Date.now()));
    log.info('刷视频学习完成', { title: v.title.slice(0, 24), chars: insight.length });
    return { ok: true, title: v.title, insight };
  } catch (err) {
    log.warn('刷视频总结失败', { err: (err as Error).message });
    return { ok: false, title: v.title };
  }
}

/** 收集某视频评论区的表情包（调用 tools/bili-scrape.mjs，不阻塞） */
function collectCommentStickers(bvid: string): void {
  try {
    const script = join(ROOT, 'tools', 'bili-scrape.mjs');
    mkdirSync(join(ROOT, 'data', 'tmp'), { recursive: true });
    const logFile = join(ROOT, 'data', 'tmp', `scrape_${bvid}.log`);
    const fd = openSync(logFile, 'w');
    const child = spawn(process.execPath, [script, '0', 'x', 'x', `--bvid=${bvid}`], {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    child.on('exit', (code) => {
      try { closeSync(fd); } catch { /* ignore */ }
      log.info('评论区表情包收集结束', { bvid, code });
    });
    child.on('error', () => {
      try { closeSync(fd); } catch { /* ignore */ }
    });
  } catch (err) {
    log.debug('收集表情包失败（忽略）', { err: (err as Error).message });
  }
}

/** 距上次学习是否超过 N 小时 */
export function dueForBrowse(hours: number): boolean {
  const at = Number(kvGet('learn:at') ?? '0');
  return Date.now() - at > hours * 3600_000;
}

export const LEARN_ROOT = ROOT;
