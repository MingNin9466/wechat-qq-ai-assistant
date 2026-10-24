/**
 * DeepSeek 客户端（2026-10 官方 API）
 *  - 对话：POST /chat/completions（OpenAI 兼容）
 *  - 视觉：同上的 content 数组，支持 base64 / URL
 *  - 联网：POST /v1/tools/search、POST /v1/tools/fetch
 *
 * 关键事实（来自官方文档）：
 *  - 思考模式开关是请求体里的 {"thinking": {"type": "enabled"|"disabled"}}
 *  - 思考模式下 temperature 不生效，所以开了思考就不传 temperature
 *  - 带 tools 时，历史轮次的 reasoning_content 必须回传，否则 400
 *  - 图片只允许出现在 user 消息里；每张图最多 1024 tokens
 */
import { config } from '../config.ts';
import { addUsage } from '../memory/store.ts';
import { createLogger } from '../infra/logger.ts';
import { isPeakHour, randInt, sleep } from '../util.ts';

const log = createLogger('llm');

// ---------------------------------------------------------------- 类型

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' };
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  usage: Usage;
  model: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  model?: string;
  thinking?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  tools?: ToolDef[];
  chatId?: string;
  kind?: 'chat' | 'vision' | 'distill';
  timeoutMs?: number;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  siteName: string | null;
  date: string | null;
  authority: number;
  score: number;
}

export interface SearchResponse {
  results: SearchResultItem[];
  cost: number;
}

export interface FetchResponse {
  title: string;
  content: string;
  cost: number;
}

export class LlmError extends Error {
  status: number;
  retryable: boolean;
  code: string;
  constructor(message: string, status = 0, code = '', retryable = false) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------- 计价

/** 元 / 百万 tokens */
interface PriceTier {
  inputMiss: number;
  inputHit: number;
  output: number;
}

const PRICING: Record<string, { peak: PriceTier; off: PriceTier }> = {
  'deepseek-flash': {
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    off: { inputMiss: 1, inputHit: 0.02, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { inputMiss: 9, inputHit: 0.3, output: 27 },
    off: { inputMiss: 4.5, inputHit: 0.15, output: 13.5 },
  },
};

export const SEARCH_COST_PER_CALL = 0.005;
export const FETCH_COST_PER_CALL = 0.005;

export function priceOf(model: string, usage: Usage, at: Date = new Date()): number {
  const tier = PRICING[model] ?? PRICING['deepseek-flash']!;
  const p = isPeakHour(at) ? tier.peak : tier.off;
  const miss = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (
    (miss * p.inputMiss + usage.cachedTokens * p.inputHit + usage.completionTokens * p.output) / 1_000_000
  );
}

// ---------------------------------------------------------------- 底层请求

export function isConfigured(): boolean {
  return Boolean(config.deepseek.apiKey);
}

function headers(): Record<string, string> {
  if (!config.deepseek.apiKey) {
    throw new LlmError('没有配置 DEEPSEEK_API_KEY，请在 .env 里填写', 0, 'no_api_key', false);
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.deepseek.apiKey}`,
  };
}

async function requestJson<T>(
  path: string,
  body: unknown,
  opts: { timeoutMs?: number; retries?: number; what?: string } = {},
): Promise<T> {
  const url = `${config.deepseek.baseUrl}${path}`;
  const timeoutMs = opts.timeoutMs ?? config.deepseek.timeoutMs;
  const retries = opts.retries ?? config.deepseek.maxRetries;
  const what = opts.what ?? path;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text.slice(0, 500);
        let code = '';
        try {
          const j = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } };
          if (j.error?.message) msg = j.error.message;
          code = j.error?.code ?? j.error?.type ?? '';
        } catch {
          /* 非 JSON 错误体 */
        }
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        const err = new LlmError(`${what} 失败 HTTP ${res.status}: ${msg}`, res.status, code, retryable);
        if (!retryable) throw err;
        lastErr = err;
        // 429 优先看 Retry-After
        const ra = Number(res.headers.get('retry-after') ?? 0);
        const waitMs = ra > 0 ? ra * 1000 : 800 * 2 ** attempt + randInt(0, 400);
        log.warn(`${what} 可重试错误，${waitMs}ms 后重试`, { attempt, status: res.status });
        await sleep(waitMs);
        continue;
      }
      const json = JSON.parse(text) as T;
      log.debug(`${what} 成功`, { ms: Date.now() - started });
      return json;
    } catch (err) {
      const e = err as Error;
      if (e instanceof LlmError && !e.retryable) throw e;
      lastErr = e;
      // AbortError / 网络错误 → 重试
      if (attempt < retries) {
        const waitMs = 800 * 2 ** attempt + randInt(0, 400);
        log.warn(`${what} 请求异常，${waitMs}ms 后重试`, { attempt, err: e.message });
        await sleep(waitMs);
        continue;
      }
    }
  }
  throw lastErr instanceof LlmError ? lastErr : new LlmError(`${what} 重试耗尽: ${lastErr?.message ?? '未知错误'}`);
}

interface RawChatResponse {
  id?: string;
  model?: string;
  choices?: {
    index: number;
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

function pickUsage(raw: RawChatResponse): Usage {
  const u = raw.usage ?? {};
  const prompt = Number(u.prompt_tokens ?? 0);
  const hit = Number(u.prompt_cache_hit_tokens ?? 0);
  return {
    promptTokens: prompt,
    completionTokens: Number(u.completion_tokens ?? 0),
    cachedTokens: hit,
  };
}

// ---------------------------------------------------------------- 对话

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  // 离线模拟：没有 API Key 时也能把整条链路跑通（npm run demo 会用）
  if (process.env.MOCK_LLM === '1') {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
    const raw = typeof lastUser?.content === 'string' ? lastUser.content : '（图片内容）';
    const text = raw.replace(/^.*?：/s, '').slice(0, 120);
    return {
      content: `[离线模拟] 收到「${text}」。\n现在没有配置 DEEPSEEK_API_KEY，所以这是本地假回复；填上 Key 后就是真正的 DeepSeek 回答。`,
      reasoning: '',
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      model: 'mock',
      toolCalls: [],
      finishReason: 'stop',
    };
  }

  const model = opts.model ?? config.deepseek.chatModel;
  const thinking = opts.thinking ?? false;
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    stream: false,
  };

  if (thinking) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = opts.reasoningEffort ?? 'high';
    // 思考模式不支持 temperature，不传
  } else {
    body.thinking = { type: 'disabled' };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
  }

  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.json) body.response_format = { type: 'json_object' };
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;

  const raw = await requestJson<RawChatResponse>('/chat/completions', body, {
    timeoutMs: opts.timeoutMs,
    what: `对话(${model})`,
  });

  const choice = raw.choices?.[0];
  const usage = pickUsage(raw);
  const cost = priceOf(model, usage);
  try {
    addUsage({
      chatId: opts.chatId,
      kind: opts.kind ?? 'chat',
      model,
      inTokens: usage.promptTokens,
      outTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
      cost,
    });
  } catch {
    /* 统计失败不影响主流程 */
  }

  return {
    content: choice?.message?.content ?? '',
    reasoning: choice?.message?.reasoning_content ?? '',
    usage,
    model: raw.model ?? model,
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason ?? 'stop',
  };
}

// ---------------------------------------------------------------- 视觉

export interface VisionInput {
  /** 本地图片文件的 MIME + base64；或公网 URL */
  images: { kind: 'base64'; mime: string; data: string }[] | { kind: 'url'; url: string }[];
  prompt: string;
}

export function buildVisionContent(input: VisionInput): ContentPart[] {
  const parts: ContentPart[] = [{ type: 'text', text: input.prompt }];
  for (const img of input.images) {
    if (img.kind === 'base64') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.data}`, detail: 'high' },
      });
    } else {
      parts.push({ type: 'image_url', image_url: { url: img.url, detail: 'high' } });
    }
  }
  return parts;
}

export async function visionChat(opts: {
  prompt: string;
  images: VisionInput['images'];
  system?: string;
  chatId?: string;
  maxTokens?: number;
}): Promise<string> {
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: buildVisionContent({ images: opts.images, prompt: opts.prompt }) });
  const res = await chat({
    messages,
    model: config.deepseek.visionModel,
    thinking: false,
    maxTokens: opts.maxTokens ?? 1200,
    chatId: opts.chatId,
    kind: 'vision',
  });
  return res.content;
}

// ---------------------------------------------------------------- 联网

export async function search(
  query: string,
  opts: { count?: number; needContent?: boolean; oriQuestion?: string; chatId?: string } = {},
): Promise<SearchResponse> {
  const raw = await requestJson<{
    results?: {
      rerank_score?: number;
      title?: string;
      url?: string;
      snippet?: string;
      summary?: string;
      content?: string;
      site_name?: string | null;
      date?: string | null;
      authority?: number;
    }[];
  }>(
    '/v1/tools/search',
    {
      query,
      count: Math.min(50, Math.max(1, opts.count ?? 6)),
      need_content: opts.needContent ?? false,
      ori_question: opts.oriQuestion ?? null,
    },
    { what: '联网搜索', timeoutMs: 30_000 },
  );

  const results: SearchResultItem[] = (raw.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.snippet ?? '',
    summary: r.summary ?? '',
    content: r.content ?? '',
    siteName: r.site_name ?? null,
    date: r.date ?? null,
    authority: Number(r.authority ?? -1),
    score: Number(r.rerank_score ?? 0),
  }));

  if (results.length > 0) {
    try {
      addUsage({ chatId: opts.chatId, kind: 'search', model: 'deepseek-search', cost: SEARCH_COST_PER_CALL });
    } catch {
      /* ignore */
    }
  }
  return { results, cost: results.length > 0 ? SEARCH_COST_PER_CALL : 0 };
}

export async function fetchPage(url: string, chatId?: string): Promise<FetchResponse> {
  const raw = await requestJson<{ title?: string; content?: string }>(
    '/v1/tools/fetch',
    { url },
    { what: '网页抓取', timeoutMs: 40_000 },
  );
  const content = raw.content ?? '';
  if (content) {
    try {
      addUsage({ chatId, kind: 'fetch', model: 'deepseek-fetch', cost: FETCH_COST_PER_CALL });
    } catch {
      /* ignore */
    }
  }
  return { title: raw.title ?? '', content, cost: content ? FETCH_COST_PER_CALL : 0 };
}

// ---------------------------------------------------------------- 工具调用循环

export interface ToolHandler {
  name: string;
  definition: ToolDef;
  run(args: Record<string, unknown>): Promise<string>;
}

/**
 * 带工具的对话循环。注意：带 tools 时 reasoning_content 必须回传，这里已处理。
 * 最多 maxRounds 轮，防止模型陷入工具死循环。
 */
export async function chatWithTools(opts: {
  messages: ChatMessage[];
  handlers: ToolHandler[];
  chatId?: string;
  model?: string;
  thinking?: boolean;
  maxRounds?: number;
  maxTokens?: number;
}): Promise<ChatResult> {
  const messages = [...opts.messages];
  const handlers = new Map(opts.handlers.map((h) => [h.name, h]));
  const maxRounds = opts.maxRounds ?? 4;
  let last: ChatResult | null = null;

  for (let round = 0; round < maxRounds; round++) {
    const res = await chat({
      messages,
      model: opts.model,
      thinking: opts.thinking,
      tools: opts.handlers.map((h) => h.definition),
      chatId: opts.chatId,
      maxTokens: opts.maxTokens,
    });
    last = res;
    if (res.toolCalls.length === 0) return res;

    messages.push({
      role: 'assistant',
      content: res.content,
      reasoning_content: res.reasoning,
      tool_calls: res.toolCalls,
    });

    for (const call of res.toolCalls) {
      const handler = handlers.get(call.function.name);
      let output: string;
      if (!handler) {
        output = JSON.stringify({ error: `未知工具 ${call.function.name}` });
      } else {
        try {
          output = await handler.run(JSON.parse(call.function.arguments || '{}') as Record<string, unknown>);
        } catch (err) {
          output = JSON.stringify({ error: (err as Error).message });
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
  return last ?? { content: '', reasoning: '', usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, model: '', toolCalls: [], finishReason: 'max_rounds' };
}

/** 轻量连通性检查（花极少量 token） */
export async function ping(): Promise<{ ok: boolean; detail: string; ms: number }> {
  const started = Date.now();
  try {
    const res = await chat({
      messages: [{ role: 'user', content: '回复"ok"两个字母即可，不要任何其他内容。' }],
      thinking: false,
      maxTokens: 8,
      kind: 'chat',
    });
    return { ok: true, detail: res.content.trim().slice(0, 30) || '(空)', ms: Date.now() - started };
  } catch (err) {
    return { ok: false, detail: (err as Error).message, ms: Date.now() - started };
  }
}
