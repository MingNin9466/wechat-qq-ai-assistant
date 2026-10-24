/**
 * 豆包（火山引擎）语音合成。
 *
 * 接口：POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   header  X-Api-Key / X-Api-Resource-Id / X-Api-Connect-Id
 *   body    { user, req_params: { text, speaker, audio_params } }
 *   返回    多行 JSON，每行 { code, message, data }，data 是 base64 音频分片
 *
 * 音色（speaker）示例：
 *   zh_female_sajiaoxuemei_uranus_bigtts  撒娇学妹（少女，默认）
 *   zh_female_vv_uranus_bigtts            Vv
 *   zh_female_cancan_uranus_bigtts        灿灿
 *   zh_male_shaonianzixin_uranus_bigtts   少年自信
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.ts';
import { createLogger } from '../infra/logger.ts';

const log = createLogger('tts-doubao');

const OUT_DIR = join(ROOT, 'data', 'voice');
const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export const DOUBAO_VOICES = [
  'zh_female_sajiaoxuemei_uranus_bigtts',
  'zh_female_vv_uranus_bigtts',
  'zh_female_cancan_uranus_bigtts',
  'zh_female_mizai_uranus_bigtts',
  'zh_female_shuangkuaisisi_uranus_bigtts',
  'zh_male_shaonianzixin_uranus_bigtts',
] as const;

export function doubaoConfigured(): boolean {
  return Boolean(process.env.DOUBAO_API_KEY);
}

/**
 * 合成一段语音，返回 mp3 路径。
 * @param text 文本（建议 ≤150 字）
 * @param speaker 音色 id
 */
export async function synthesizeDoubao(
  text: string,
  speaker = process.env.DOUBAO_VOICE ?? 'zh_female_sajiaoxuemei_uranus_bigtts',
): Promise<string | null> {
  const key = process.env.DOUBAO_API_KEY;
  if (!key) return null;
  const clean = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[*#`>]/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim()
    .slice(0, 200);
  if (!clean) return null;

  const body = {
    user: { uid: 'dsh-group-bot' },
    req_params: {
      text: clean,
      speaker,
      audio_params: { format: 'mp3', sample_rate: 24000 },
    },
  };

  let raw = '';
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': key,
        'X-Api-Resource-Id': process.env.DOUBAO_RESOURCE ?? 'seed-tts-2.0',
        'X-Api-Connect-Id': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    raw = await res.text();
    if (!res.ok) {
      log.warn('豆包合成失败', { status: res.status, body: raw.slice(0, 200) });
      return null;
    }
  } catch (err) {
    log.warn('豆包接口异常', { err: (err as Error).message });
    return null;
  }

  // 多行 JSON：每行一个分片
  const chunks: Buffer[] = [];
  let code = 0;
  let message = '';
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const j = JSON.parse(s) as { code?: number; message?: string; data?: string };
      if (typeof j.code === 'number' && j.code !== 0) {
        code = j.code;
        message = j.message ?? '';
      }
      if (j.data) chunks.push(Buffer.from(j.data, 'base64'));
    } catch {
      /* 跳过坏行 */
    }
  }
  if (!chunks.length) {
    log.warn('豆包没有返回音频', { code, message });
    return null;
  }

  const audio = Buffer.concat(chunks);
  if (audio.length < 1500) {
    log.warn('豆包音频过小', { bytes: audio.length });
    return null;
  }
  try {
    mkdirSync(OUT_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  const out = join(OUT_DIR, `doubao_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`);
  writeFileSync(out, audio);
  if (!existsSync(out) || statSync(out).size < 1500) return null;
  log.info('豆包语音就绪', { chars: clean.length, kb: Math.round(audio.length / 1024), speaker });
  return out;
}
