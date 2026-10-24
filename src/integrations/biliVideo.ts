/**
 * B 站视频内容理解：下载一小段 → 抽帧 → 交给识图模型。
 *
 * 依赖两个外部程序（放在 tools/ 下，不进 npm 依赖）：
 *   tools/yt-dlp.exe                 下载视频（支持 B 站，需带 Referer）
 *   tools/ffmpeg/ffmpeg.exe          抽帧
 *
 * 设计取舍：只下"前 N 秒 + 最低画质"，避免为了一句话总结下几百 MB。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.ts';
import { createLogger } from '../infra/logger.ts';

const log = createLogger('biliVideo');

const PYTHON = process.env.PYTHON_PATH ?? 'D:\\PyBot\\python.exe';
const FFMPEG = process.env.FFMPEG_PATH ?? join(ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe');
const TMP_ROOT = join(ROOT, 'data', 'tmp');

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; out: string }> {
  // 本机沙箱禁止 Node 用管道捕获子进程输出（spawn EPERM），
  // 因此用 spawn + 文件重定向（stdio 指向文件描述符，而不是 pipe）。
  const logFile = join(TMP_ROOT, `spawn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.log`);
  return new Promise((resolve) => {
    let fd: number;
    try {
      mkdirSync(TMP_ROOT, { recursive: true });
      fd = openSync(logFile, 'w');
    } catch {
      resolve({ ok: false, out: '无法创建子进程日志文件' });
      return;
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      let out = '';
      try {
        out = readFileSync(logFile, 'utf8').trim();
      } catch {
        /* ignore */
      }
      try {
        rmSync(logFile, { force: true });
      } catch {
        /* ignore */
      }
      resolve({ ok, out: out.slice(-4000) });
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', fd, fd], windowsHide: true });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

export function videoToolsReady(): boolean {
  // yt-dlp 用 Python 模块方式调用：PyInstaller 的 exe 在含中文的路径下起不来
  return existsSync(PYTHON) && existsSync(FFMPEG);
}

export interface FrameResult {
  frames: Buffer[];
  clipSeconds: number;
  source: string;
}

/** 最近一次失败原因（给上层拼提示用） */
export let lastError = '';

export function getLastVideoError(): string {
  return lastError;
}

/**
 * 抓取视频前若干秒并抽帧。
 * @param url 视频页地址
 * @param seconds 下载时长（默认 45 秒）
 * @param count 抽帧数量（默认 4）
 */
export async function extractBiliFrames(url: string, seconds = 45, count = 4): Promise<FrameResult | null> {
  if (!videoToolsReady()) {
    log.warn('yt-dlp 或 ffmpeg 缺失，跳过视频理解');
    return null;
  }
  const work = join(TMP_ROOT, `bili_${Date.now()}`);
  lastError = '';
  try {
    mkdirSync(work, { recursive: true });

    // 1) 下载低画质整段（限 80MB）。
    //    注意：不能用 --download-sections——它要 ffmpeg 直接读远程 URL，
    //    而本机 ffmpeg 的 schannel TLS 不可用（0x8009030e），必然失败。
    const cookieFile = join(ROOT, 'data', 'bili_cookies.txt');
    const cookieArgs = existsSync(cookieFile) ? ['--cookies', cookieFile] : [];
    const dl = await run(
      PYTHON,
      [
        '-m',
        'yt_dlp',
        '--no-playlist',
        '--no-warnings',
        ...cookieArgs,
        '-f',
        // 按宽度筛，不按高度：竖屏视频是 360x638 这种，height 会很大
        'bv*[width<=720]+ba/b[width<=720]/bv*+ba/b',
        '--max-filesize',
        '120M',
        '--merge-output-format',
        'mp4',
        '--ffmpeg-location',
        FFMPEG.replace(/[\\/]ffmpeg\.exe$/i, ''),
        '--referer',
        'https://www.bilibili.com/',
        '-o',
        join(work, 'clip.%(ext)s'),
        url,
      ],
      300_000,
    );
    if (!dl.ok) {
      const needLogin = /login|authentication|cookies|会员|VIP|大会员/i.test(dl.out);
      log.warn(needLogin ? 'yt-dlp 需要登录态（缺 Cookie）' : 'yt-dlp 下载失败', { tail: dl.out.slice(-300) });
      lastError = needLogin ? '需要登录才能看这个视频' : '视频下载失败';
      return null;
    }

    const files = readdirSync(work).filter((f) => f.startsWith('clip.'));
    const clip = files.map((f) => join(work, f)).find((f) => /\.(mp4|flv|mkv|webm|m4a)$/i.test(f));
    if (!clip) {
      log.warn('没找到下载下来的片段');
      return null;
    }

    // 2) 按时间点均匀抽帧（用本地文件，避开网络/TLS）
    const ffprobe = FFMPEG.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
    let duration = 0;
    if (existsSync(ffprobe)) {
      const pr = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip], 30_000);
      duration = Number.parseFloat(pr.out.split('\n').pop() ?? '') || 0;
    }
    const frameFiles: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = duration > 0 ? (duration * (i + 1)) / (count + 1) : i * 5;
      const outFrame = join(work, `f${String(i).padStart(2, '0')}.jpg`);
      const ff = await run(
        FFMPEG,
        ['-y', '-ss', String(t.toFixed(2)), '-i', clip, '-frames:v', '1', '-vf', 'scale=640:-2', outFrame],
        45_000,
      );
      if (ff.ok && existsSync(outFrame)) frameFiles.push(outFrame);
    }
    const frames = frameFiles.map((f) => readFileSync(f));
    if (frames.length === 0) return null;

    log.info('视频帧已抽取', { url: url.slice(0, 60), frames: frames.length, duration: Math.round(duration) });
    return { frames, clipSeconds: Math.round(duration) || seconds, source: url };
  } catch (err) {
    log.warn('视频处理异常', { err: (err as Error).message });
    return null;
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* 清理失败无所谓 */
    }
  }
}
