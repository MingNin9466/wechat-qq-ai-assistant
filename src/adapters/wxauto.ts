/**
 * wxauto 适配器（Python 桥接版）。
 *
 * Node 不直接操作微信：Python 进程（bridge/wechat_bridge.py）负责用 wxauto 收发，
 * 这里通过本地 HTTP 拉消息 / 发消息。好处是 wxauto 崩了不影响主程序，主程序重启也不用重登微信。
 *
 * 依赖：先起桥接进程
 *   node bridge/run.mjs          （会自动找 Python）
 * 或手动：
 *   python bridge/wechat_bridge.py --chat "测试群" --self-name 小深
 */
import { createLogger } from '../infra/logger.ts';
import type {
  AdapterEvent,
  IncomingMessage,
  MessageKind,
  Outgoing,
  WeChatAdapter,
} from './types.ts';

const log = createLogger('adapter:wxauto');

interface BridgeHealth {
  ok: boolean;
  package: string;
  plus: boolean;
  chat: string | null;
  self: string;
}

interface BridgeMessage {
  id: string;
  chatId: string;
  chatName?: string;
  senderId: string;
  senderName: string;
  isGroup: boolean;
  isSelf: boolean;
  isAtMe: boolean;
  kind: string;
  text: string;
  rawType: string;
  mediaPath: string | null;
  ts: number;
}

const KINDS: MessageKind[] = [
  'text',
  'image',
  'voice',
  'video',
  'file',
  'link',
  'emoticon',
  'system',
  'other',
];

function normalizeKind(kind: string): MessageKind {
  return (KINDS as string[]).includes(kind) ? (kind as MessageKind) : 'other';
}

export class WxautoAdapter implements WeChatAdapter {
  readonly name = 'wxauto';
  private baseUrl: string;
  private pollTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private stopping = false;
  private polling = false;
  private health: BridgeHealth | null = null;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private eventHandler: ((ev: AdapterEvent) => void) | null = null;
  private failCount = 0;
  private lastDeliveredTs = 0;
  private pollIntervalMs: number;

  constructor(baseUrl = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8899', pollIntervalMs = 800) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const health = await this.waitForBridge();
    this.health = health;
    this.connected = true;
    log.info('桥接进程已连接', {
      package: health.package,
      plus: health.plus,
      chat: health.chat,
      self: health.self,
    });
    this.eventHandler?.({ type: 'login', wxid: `wxauto:${health.self}`, name: health.self });

    this.stopping = false;
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  self(): { wxid: string; name: string } | null {
    if (!this.health) return null;
    return { wxid: `wxauto:${this.health.self}`, name: this.health.self };
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  onEvent(handler: (ev: AdapterEvent) => void): void {
    this.eventHandler = handler;
  }

  /** 按需让桥接下载并解密媒体（图片/视频/语音），返回本地路径 */
  async downloadMedia(msg: IncomingMessage): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: msg.chatId, id: msg.id }),
        signal: AbortSignal.timeout(180_000),
      });
      const data = (await res.json()) as { ok?: boolean; path?: string; error?: string };
      if (!res.ok || data.ok === false || !data.path) return null;
      return data.path;
    } catch {
      return null;
    }
  }

  /** 发一张图片/表情包（走剪贴板 + 聚焦粘贴，不移动鼠标） */
  async sendImage(chatId: string, path: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/send-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: chatId, path }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        log.warn('发图失败', { chat: chatId, err: data.error });
        return false;
      }
      return true;
    } catch (err) {
      log.warn('发图异常', { err: (err as Error).message });
      return false;
    }
  }

  /** 发一个文件（语音 mp3 等），走剪贴板粘贴，不移动鼠标 */
  async sendFile(chatId: string, path: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/send-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: chatId, path }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        log.warn('发文件失败', { chat: chatId, err: data.error });
        return false;
      }
      return true;
    } catch (err) {
      log.warn('发文件异常', { err: (err as Error).message });
      return false;
    }
  }

  /** 用户是不是正在用全屏程序（游戏/视频）——此时绝不能抢窗口 */
  async isUserBusy(): Promise<{ busy: boolean; title?: string; exe?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/foreground`, { signal: AbortSignal.timeout(2000) });
      const j = (await res.json()) as { fullscreen?: boolean; title?: string; exe?: string };
      return { busy: Boolean(j.fullscreen), title: j.title, exe: j.exe };
    } catch {
      return { busy: false };
    }
  }

  // ------------------------------------------------------------ 内部

  private async waitForBridge(): Promise<BridgeHealth> {
    const deadline = Date.now() + 20_000;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          return (await res.json()) as BridgeHealth;
        }
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = (err as Error).message;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error(
      `连接不上桥接进程 ${this.baseUrl}（${lastErr}）。\n` +
        '请先启动：node bridge/run.mjs  或  python bridge/wechat_bridge.py --chat "你的群名"',
    );
  }

  private async tick(): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      // 上一次投递失败过 → 带 since 让桥接补发，避免"两个群同时发只收到一个"
      const replay = this.failCount > 0 && this.lastDeliveredTs > 0;
      const url = `${this.baseUrl}/poll${replay ? `?since=${this.lastDeliveredTs}` : ''}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`poll HTTP ${res.status}`);
      const data = (await res.json()) as { ok: boolean; messages?: BridgeMessage[]; error?: string };
      if (!data.ok) throw new Error(data.error ?? 'poll failed');
      if (this.failCount > 0) {
        this.failCount = 0;
        this.connected = true;
        log.info('桥接进程恢复');
      }
      for (const raw of data.messages ?? []) {
        const msg = this.toIncoming(raw);
        if (!msg) continue;
        const ts = Number(raw.ts ?? msg.ts ?? 0);
        if (ts > this.lastDeliveredTs) this.lastDeliveredTs = ts;
        this.messageHandler?.(msg);
      }
    } catch (err) {
      this.failCount++;
      if (this.failCount === 3) {
        this.connected = false;
        log.error('桥接进程连续失败', { err: (err as Error).message });
        this.eventHandler?.({ type: 'error', error: err as Error });
      } else {
        log.debug('poll 失败（可容忍）', { err: (err as Error).message, count: this.failCount });
      }
    } finally {
      this.polling = false;
    }
  }

  private toIncoming(raw: BridgeMessage): IncomingMessage | null {
    if (!raw?.id) return null;
    return {
      id: String(raw.id),
      chatId: raw.chatId || raw.chatName || '',
      chatName: raw.chatName,
      senderId: raw.senderId,
      senderName: raw.senderName,
      isGroup: Boolean(raw.isGroup),
      isSelf: Boolean(raw.isSelf),
      isAtMe: Boolean(raw.isAtMe),
      kind: normalizeKind(raw.kind),
      text: raw.text ?? '',
      rawType: typeof raw.rawType === 'number' ? raw.rawType : 0,
      media: raw.mediaPath ? { path: raw.mediaPath } : undefined,
      ts: Number(raw.ts) || Date.now(),
    };
  }

  async send(chatId: string, msg: Outgoing): Promise<void> {
    let body: Record<string, unknown>;
    if (msg.kind === 'text') {
      body = { kind: 'text', chat: chatId, text: msg.text };
    } else if (msg.kind === 'image') {
      body = { kind: 'image', chat: chatId, path: msg.path };
    } else if (msg.kind === 'file') {
      body = { kind: 'file', chat: chatId, path: msg.path };
    } else {
      body = {
        kind: 'link',
        chat: chatId,
        url: msg.url,
        title: msg.title,
        digest: msg.digest ?? '',
        thumbUrl: msg.thumbUrl ?? '',
        sourceName: msg.sourceName ?? '',
      };
    }

    const res = await fetch(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(`桥接发送失败：${data.error ?? `HTTP ${res.status}`}`);
    }
  }

  /** 切换要盯的群（运行时可改） */
  async setTarget(chat: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (this.health) this.health.chat = chat;
  }
}
