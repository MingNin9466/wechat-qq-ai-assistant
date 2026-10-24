/**
 * OneBot 11 适配器：把 QQ（NapCat / SnowLuma 等协议端）接进同一套调度器。
 *
 * 收发方式：
 *   收 —— 起一个本地 HTTP 服务，接收协议端「HTTP POST 上报」的事件
 *         NapCat 里配置：HTTP 上报地址 http://127.0.0.1:8901/onebot
 *   发 —— 调用协议端的 HTTP API：http://127.0.0.1:3000/send_group_msg 等
 *
 * chatId 约定（调度器靠前缀路由）：
 *   qq:group:<群号>     群聊
 *   qq:pv:<QQ号>        私聊
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../infra/logger.ts';
import type {
  AdapterEvent,
  IncomingMessage,
  MessageKind,
  Outgoing,
  WeChatAdapter,
} from './types.ts';

const log = createLogger('adapter:qq');

interface OneBotEvent {
  post_type?: string;
  message_type?: 'group' | 'private';
  sub_type?: string;
  self_id?: number;
  user_id?: number;
  group_id?: number;
  message_id?: number;
  raw_message?: string;
  message?: unknown;
  sender?: { user_id?: number; nickname?: string; card?: string };
  time?: number;
}

interface Segment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotOptions {
  /** 接收事件的本地端口 */
  listenPort?: number;
  /** 协议端 HTTP API 地址 */
  apiBase?: string;
  /** 访问 API 用的 token（可空） */
  token?: string;
}

export class OneBotAdapter implements WeChatAdapter {
  readonly name = 'onebot';
  private listenPort: number;
  private apiBase: string;
  private token: string;
  private server: Server | null = null;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private eventHandler: ((ev: AdapterEvent) => void) | null = null;
  private connected = false;
  private selfInfo: { wxid: string; name: string } | null = null;
  /** 消息 id → 图片/语音的远程地址（OneBot 的 image/record 段会带 url） */
  private mediaUrls = new Map<string, { url: string; kind: string }>();

  constructor(opts: OneBotOptions = {}) {
    this.listenPort = opts.listenPort ?? Number(process.env.QQ_LISTEN_PORT ?? 8901);
    this.apiBase = (opts.apiBase ?? process.env.QQ_API_BASE ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.token = opts.token ?? process.env.QQ_TOKEN ?? '';
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => {
        if (req.method !== 'POST' || !req.url?.startsWith('/onebot')) {
          res.writeHead(404).end();
          return;
        }
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 4_000_000) req.destroy();
        });
        req.on('end', () => {
          res.writeHead(204).end();
          try {
            this.handleEvent(JSON.parse(body) as OneBotEvent);
          } catch (err) {
            log.debug('事件解析失败', { err: (err as Error).message });
          }
        });
      });
      this.server.on('error', reject);
      this.server.listen(this.listenPort, '127.0.0.1', () => {
        this.connected = true;
        log.info('QQ 事件监听已启动', { port: this.listenPort, api: this.apiBase });
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  onEvent(handler: (ev: AdapterEvent) => void): void {
    this.eventHandler = handler;
  }

  self(): { wxid: string; name: string } | null {
    return this.selfInfo;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** 把 OneBot 事件转成统一消息；非消息事件返回 null */
  private handleEvent(ev: OneBotEvent): void {
    if (ev.post_type === 'meta_event' && ev.self_id) {
      if (!this.selfInfo) {
        this.selfInfo = { wxid: String(ev.self_id), name: 'QQ' };
        this.eventHandler?.({ type: 'login', wxid: String(ev.self_id), name: 'QQ' });
      }
      return;
    }
    if (ev.post_type !== 'message') return;

    const isGroup = ev.message_type === 'group';
    const groupId = ev.group_id ?? 0;
    const userId = ev.user_id ?? ev.sender?.user_id ?? 0;
    const messageId = ev.message_id ?? 0;
    if (!messageId || !userId) return;

    const segs = this.segments(ev.message, ev.raw_message ?? '');
    const textParts: string[] = [];
    let kind: MessageKind = 'text';
    let hasAtMe = false;
    const selfId = Number(this.selfInfo?.wxid ?? ev.self_id ?? 0);

    for (const s of segs) {
      if (s.type === 'text') textParts.push(String(s.data?.text ?? ''));
      else if (s.type === 'at') {
        if (Number(s.data?.qq) === selfId || s.data?.qq === 'all') hasAtMe = true;
      } else if (s.type === 'image') {
        kind = 'image';
        const u = String(s.data?.url ?? s.data?.file ?? '');
        if (u) this.mediaUrls.set(String(messageId), { url: u, kind: 'image' });
      }
      else if (s.type === 'face' || s.type === 'mface') {
        if (kind === 'text') kind = 'emoticon';
      } else if (s.type === 'record') kind = 'voice';
      else if (s.type === 'video') kind = 'video';
      else if (s.type === 'file') kind = 'file';
    }

    const text = textParts.join('').replace(/\s+/g, ' ').trim();
    const chatId = isGroup ? `qq:group:${groupId}` : `qq:pv:${userId}`;
    const msg: IncomingMessage = {
      id: `qq:${messageId}`,
      chatId,
      chatName: isGroup ? `QQ群${groupId}` : ev.sender?.nickname ?? `QQ${userId}`,
      senderId: String(userId),
      senderName: ev.sender?.card || ev.sender?.nickname || String(userId),
      isGroup,
      isSelf: false,
      isAtMe: isGroup ? hasAtMe : true,
      kind,
      text,
      rawType: 0,
      ts: (ev.time ?? Math.floor(Date.now() / 1000)) * 1000,
    };
    log.debug('QQ 消息', { chat: chatId, sender: msg.senderName, kind, at: msg.isAtMe });
    this.messageHandler?.(msg);
  }

  private segments(message: unknown, raw: string): Segment[] {
    if (Array.isArray(message)) return message as Segment[];
    // string 形式的 CQ 码
    if (typeof message === 'string' && message.includes('[CQ:')) {
      const out: Segment[] = [];
      const re = /\[CQ:([a-z]+)((?:,[^\]]*)?)\]/g;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(message))) {
        if (m.index > last) out.push({ type: 'text', data: { text: message.slice(last, m.index) } });
        const data: Record<string, string> = {};
        for (const kv of (m[2] ?? '').split(',').filter(Boolean)) {
          const i = kv.indexOf('=');
          if (i > 0) data[kv.slice(0, i)] = kv.slice(i + 1);
        }
        out.push({ type: m[1]!, data });
        last = m.index + m[0].length;
      }
      if (last < message.length) out.push({ type: 'text', data: { text: message.slice(last) } });
      return out;
    }
    return [{ type: 'text', data: { text: raw } }];
  }

  private async callApi(action: string, params: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiBase}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json()) as { status?: string; retcode?: number; message?: string };
      if (j.status === 'failed' || (j.retcode ?? 0) !== 0) {
        log.warn('QQ API 失败', { action, msg: j.message, retcode: j.retcode });
        return false;
      }
      return true;
    } catch (err) {
      log.warn('QQ API 异常', { action, err: (err as Error).message });
      return false;
    }
  }

  private target(chatId: string): { action: string; key: string } | null {
    const g = chatId.match(/^qq:group:(\d+)$/);
    if (g) return { action: 'send_group_msg', key: 'group_id' };
    const p = chatId.match(/^qq:pv:(\d+)$/);
    if (p) return { action: 'send_private_msg', key: 'user_id' };
    return null;
  }

  private idOf(chatId: string): number {
    const m = chatId.match(/(\d+)$/);
    return m ? Number(m[1]) : 0;
  }


  /** 下载 QQ 的图片/语音到本地，供识图使用 */
  async downloadMedia(msg: IncomingMessage): Promise<string | null> {
    try {
      const id = msg.id.replace(/^qq:/, '');
      const hit = this.mediaUrls.get(id);
      const url = hit?.url ?? '';
      if (!url) return null;
      // 已经是本地路径
      if (!/^https?:/i.test(url)) {
        return existsSync(url) ? url : null;
      }
      const dir = join(homedir(), '.dsh', 'qq-media');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200 || buf.length > 20 * 1024 * 1024) return null;
      const ext =
        buf[0] === 0x89 && buf[1] === 0x50
          ? '.png'
          : buf[0] === 0x47 && buf[1] === 0x49
            ? '.gif'
            : buf[0] === 0x52 && buf[8] === 0x57
              ? '.webp'
              : '.jpg';
      const file = join(dir, `qq_${id}${ext}`);
      writeFileSync(file, buf);
      this.mediaUrls.delete(id);
      return file;
    } catch (err) {
      log.debug('QQ 媒体下载失败', { err: (err as Error).message });
      return null;
    }
  }
  async send(chatId: string, msg: Outgoing): Promise<void> {
    const t = this.target(chatId);
    if (!t) {
      log.warn('未知的 QQ 会话 id', { chatId });
      return;
    }
    let segments: Segment[];
    if (msg.kind === 'text') {
      segments = [{ type: 'text', data: { text: msg.text } }];
    } else if (msg.kind === 'image') {
      segments = [{ type: 'image', data: { file: this.fileUrl(msg.path) } }];
    } else if (msg.kind === 'file') {
      segments = [{ type: 'file', data: { file: this.fileUrl(msg.path), name: msg.name ?? '' } }];
    } else {
      const link = msg.kind === 'link' ? `${msg.title}\n${msg.url}` : '';
      segments = [{ type: 'text', data: { text: link } }];
    }
    await this.callApi(t.action, { [t.key]: this.idOf(chatId), message: segments });
  }

  async sendImage(chatId: string, path: string): Promise<boolean> {
    const t = this.target(chatId);
    if (!t) return false;
    return this.callApi(t.action, {
      [t.key]: this.idOf(chatId),
      message: [{ type: 'image', data: { file: this.fileUrl(path) } }],
    });
  }

  async sendFile(chatId: string, path: string): Promise<boolean> {
    const t = this.target(chatId);
    if (!t) return false;
    return this.callApi(t.action, {
      [t.key]: this.idOf(chatId),
      message: [{ type: 'file', data: { file: this.fileUrl(path), name: path.split(/[\\/]/).pop() ?? '' } }],
    });
  }

  /** QQ 原生语音条（record 段）。NapCat 会把 mp3 转成 SILK。 */
  async sendVoice(chatId: string, path: string): Promise<boolean> {
    const t = this.target(chatId);
    if (!t) return false;
    return this.callApi(t.action, {
      [t.key]: this.idOf(chatId),
      message: [{ type: 'record', data: { file: this.fileUrl(path) } }],
    });
  }

  /** 本地文件 → file:/// URL（OneBot 通用写法） */
  private fileUrl(path: string): string {
    const p = path.replace(/\\/g, '/');
    return existsSync(path) ? `file:///${p.replace(/^\/+/, '')}` : p;
  }

  /** 供外部读取：最近一条原始事件（调试用） */
  lastRaw = '';
  readStdin: () => string = () => readFileSync(0, 'utf8');
}
