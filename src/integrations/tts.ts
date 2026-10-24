/**
 * 语音合成：用 edge-tts（微软 Edge 的在线 TTS，免费）把文字转成 mp3。
 *
 * 音色选择（AI 视频作者给"AI 娘"配音最常用的几个）：
 *   zh-CN-XiaoyiNeural   少女音，活泼（默认）
 *   zh-CN-XiaoxiaoNeural 温柔女声
 *   zh-CN-XiaobeiNeural  东北味
 *   zh-CN-YunxiNeural    男声
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.ts';
import { createLogger } from '../infra/logger.ts';

const log = createLogger('tts');

const PYTHON = process.env.PYTHON_PATH ?? 'D:\\PyBot\\python.exe';
const OUT_DIR = join(ROOT, 'data', 'voice');
const TMP = join(ROOT, 'data', 'tmp');
const FFMPEG = join(ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe');

export const VOICES = [
  'zh-CN-XiaoyiNeural',
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaobeiNeural',
  'zh-CN-YunxiNeural',
] as const;

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<boolean> {
  const logFile = join(TMP, `tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.log`);
  return new Promise((resolve) => {
    let fd: number;
    try {
      mkdirSync(TMP, { recursive: true });
      fd = openSync(logFile, 'w');
    } catch {
      resolve(false);
      return;
    }
    const child = spawn(cmd, args, { stdio: ['ignore', fd, fd], windowsHide: true });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        closeSync(fd);
        rmSync(logFile, { force: true });
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

/**
 * 合成语音，返回 mp3 路径。
 * @param text 要说的内容（建议 ≤120 字，太长会很慢）
 */
export async function synthesize(text: string, voice: string = VOICES[0]): Promise<string | null> {
  // 引擎与音色从后台设定读，改完立即生效（不用重启）
  const { getSetting } = await import('../core/settings.ts');
  const engine = getSetting<string>('voiceEngine') || (process.env.DOUBAO_API_KEY ? 'doubao' : 'edge');
  if (engine === 'doubao' && process.env.DOUBAO_API_KEY) {
    try {
      const { synthesizeDoubao } = await import('./doubao.ts');
      const speaker = getSetting<string>('doubaoVoiceId') || process.env.DOUBAO_VOICE || 'zh_female_sajiaoxuemei_uranus_bigtts';
      const res = getSetting<string>('doubaoResource') || process.env.DOUBAO_RESOURCE || 'seed-tts-2.0';
      process.env.DOUBAO_RESOURCE = res;
      const p = await synthesizeDoubao(text, speaker);
      if (p) return p;
      log.warn('豆包没出音频，退回 edge-tts');
    } catch (err) {
      log.warn('豆包异常，退回 edge-tts', { err: (err as Error).message });
    }
  }
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/[*#`>]/g, '').trim().slice(0, 200);
  if (!clean) return null;
  if (!existsSync(PYTHON)) {
    log.warn('找不到 python，无法合成语音', { PYTHON });
    return null;
  }
  try {
    mkdirSync(OUT_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  const out = join(OUT_DIR, `tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`);
  // 语调微调：默认的朗读腔偏平，稍微提一点语速和音高，听起来更活泼
  const rate = process.env.TTS_RATE ?? '+8%';
  const pitch = process.env.TTS_PITCH ?? '+3Hz';
  const ok = await run(
    PYTHON,
    [
      '-m', 'edge_tts',
      '--voice', voice,
      '--rate', rate,
      '--pitch', pitch,
      '--text', clean,
      '--write-media', out,
    ],
    90_000,
  );
  if (!ok || !existsSync(out)) {
    log.warn('edge-tts 合成失败', { voice, chars: clean.length });
    return null;
  }

  // 可选：再整体变调（把声音变年轻）。ratio>1 变高变嫩，0 或 1 表示不变。
  const ratio = Number(process.env.TTS_RATIO ?? '0');
  if (ratio > 1.01) {
    const shifted = out.replace(/\.mp3$/, `_p${Math.round(ratio * 100)}.mp3`);
    const tempo = (1 / ratio).toFixed(4);
    const af = `asetrate=24000*${ratio},aresample=24000,atempo=${tempo}`;
    const okShift = await run(FFMPEG, ['-y', '-i', out, '-af', af, '-b:a', '64k', shifted], 60_000);
    if (okShift && existsSync(shifted)) {
      try {
        rmSync(out, { force: true });
      } catch {
        /* ignore */
      }
      log.info('语音变调完成', { ratio, file: shifted.split(/[\\/]/).pop() });
      return shifted;
    }
    log.warn('变调失败，改用原音');
  }
  try {
    if (statSync(out).size < 1200) {
      log.warn('合成结果过小，忽略', { out });
      rmSync(out, { force: true });
      return null;
    }
  } catch {
    /* ignore */
  }
  log.info('语音合成完成', { voice, chars: clean.length, file: out.split(/[\\/]/).pop() });
  return out;
}
