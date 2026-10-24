/**
 * 用 DSH「朗读桥」出声 + 回环录音，拿到 DeepSeek 那个更自然的音色。
 *
 * 链路：
 *   1. 后台起录音器（tools/speak-record.py，录扬声器回环，静音 1.2 秒自动停）
 *   2. POST 到 DSH 朗读桥 /dsh-tts-bridge/say，让浏览器把文本念出来
 *   3. 录音器自己判断说完就退出
 *   4. wav → mp3（给 QQ 发语音条 / 微信发文件）
 *
 * 依赖：DSH 开着 + 浏览器装了朗读桥扩展 + DeepSeek 页面开着并登录。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.ts';
import { createLogger } from '../infra/logger.ts';

const log = createLogger('tts-bridge');

const PYTHON = process.env.PYTHON_PATH ?? 'D:\\PyBot\\python.exe';
const FFMPEG = join(ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe');
const TMP = join(ROOT, 'data', 'tmp');
const OUT = join(ROOT, 'data', 'voice');

/** 找 DSH 的 web 端口（每次启动会变，靠探测 /dsh-tts-bridge/status 确认） */
let cachedBase = '';
export async function findBridgeBase(): Promise<string> {
  if (cachedBase) return cachedBase;
  const manual = process.env.DSH_TTS_BASE;
  if (manual) {
    cachedBase = manual.replace(/\/+$/, '');
    return cachedBase;
  }
  // 从 netstat 里挑出本机监听端口，逐个探一下
  const ports = await listLocalPorts();
  for (const port of ports) {
    const base = `http://127.0.0.1:${port}/dsh-tts-bridge`;
    try {
      const r = await fetch(`${base}/status`, { signal: AbortSignal.timeout(400) });
      if (r.ok) {
        const j = (await r.json()) as { ok?: boolean };
        if (j.ok) {
          cachedBase = base;
          log.info('找到朗读桥', { base });
          return base;
        }
      }
    } catch {
      /* 继续试下一个 */
    }
  }
  return '';
}

function listLocalPorts(): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
    child.on('exit', () => {
      const ports = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/127\.0\.0\.1:(\d{4,5})\s+\S+\s+LISTENING/i);
        if (m?.[1]) {
          const p = Number(m[1]);
          if (p >= 20000 && p <= 65535) ports.add(p);
        }
      }
      resolve([...ports].sort((a, b) => b - a).slice(0, 40));
    });
    child.on('error', () => resolve([]));
  });
}

function runDetached(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    mkdirSync(TMP, { recursive: true });
    const logFile = join(TMP, `rec_${Date.now()}.log`);
    let fd: number;
    try {
      fd = openSync(logFile, 'w');
    } catch {
      resolve(false);
      return;
    }
    const child = spawn(cmd, args, { stdio: ['ignore', fd, fd], windowsHide: true });
    child.on('exit', (code) => {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      resolve(code === 0);
    });
    child.on('error', () => resolve(false));
  });
}

/**
 * 让浏览器念一段话，录下来，返回 mp3 路径。
 * @param text 要念的内容（建议 ≤80 字，等太久）
 */
export async function synthesizeViaBridge(text: string): Promise<string | null> {
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/[*#`>]|\[[^\]]*\]/g, '').trim().slice(0, 120);
  if (!clean) return null;

  const base = await findBridgeBase();
  if (!base) {
    log.warn('没找到 DSH 朗读桥（DSH 没开？）');
    return null;
  }
  if (!existsSync(PYTHON)) return null;
  mkdirSync(OUT, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const wav = join(TMP, `say_${stamp}.wav`);
  const mp3 = join(OUT, `tts_bridge_${stamp}.mp3`);

  // 1) 先开录音（后台），给它 1 秒准备
  const recPromise = runDetached(PYTHON, [
    join(ROOT, 'tools', 'speak-record.py'),
    '--out', wav,
    '--max', '45',
    '--silence', '1.2',
    '--start-timeout', '40',
  ]);
  await new Promise((r) => setTimeout(r, 1000));

  // 2) 推给朗读桥
  try {
    const r = await fetch(`${base}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) log.warn('朗读桥不接受', { status: r.status });
  } catch (err) {
    log.warn('推给朗读桥失败', { err: (err as Error).message });
    return null;
  }

  // 3) 等录音结束（说完 + 静音）
  const ok = await recPromise;
  if (!ok || !existsSync(wav) || statSync(wav).size < 8000) {
    log.warn('没录到声音（浏览器没念出来？）');
    try {
      if (existsSync(wav)) unlinkSync(wav);
    } catch {
      /* ignore */
    }
    return null;
  }

  // 4) wav → mp3
  const conv = await runDetached(FFMPEG, ['-y', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '4', mp3]);
  try {
    unlinkSync(wav);
  } catch {
    /* ignore */
  }
  if (!conv || !existsSync(mp3)) return null;
  log.info('朗读桥语音就绪', { chars: clean.length, kb: Math.round(statSync(mp3).size / 1024) });
  return mp3;
}
