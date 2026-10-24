/**
 * WeChatFerry 适配器（微信 3.9.12.17 + 小号）。
 *
 * 依赖 @wechatferry/agent（Node 生态的 WCF 客户端），动态引入：
 *  - 没装/没开微信时，报出人能看懂的错，而不是堆栈。
 *  - 微信掉线后由 main 里的看门狗负责重启，本类只负责上报事件。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { createLogger } from '../infra/logger.ts';
import { pickXmlTag, type AdapterEvent, type IncomingMessage, type MessageKind, type Outgoing, type WeChatAdapter } from './types.ts';

const log = createLogger('adapter:wcf');

type AnyAgent = {
  start(): void;
  stop(error?: unknown): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
  sendText(conversationId: string, text: string, mentionIdList?: string[]): number;
  sendImage(conversationId: string, image: unknown): Promise<number>;
  sendFile(conversationId: string, file: unknown): Promise<number>;
  sendRichText(conversationId: string, desc: Record<string, unknown>): number;
  downloadFile(message: unknown, timeout?: number): Promise<{ toBuffer(): Promise<Buffer> }>;
  getContactInfo(userName: string): { nickName?: string; remark?: string } | undefined;
  getChatRoomInfo(userName: string): { nickName?: string } | undefined;
  wcf: { getSelfWxid(): string; getUserInfo(): { name?: string; wxid?: string } };
};

/** 微信消息类型 → 统一类型 */
function kindOf(type: number, xml: string): { kind: MessageKind; appType: number } {
  switch (type) {
    case 1:
      return { kind: 'text', appType: 0 };
    case 3:
      return { kind: 'image', appType: 0 };
    case 34:
      return { kind: 'voice', appType: 0 };
    case 43:
    case 62:
      return { kind: 'video', appType: 0 };
    case 47:
      return { kind: 'emoticon', appType: 0 };
    case 49: {
      const appType = Number(pickXmlTag(xml, 'type') || 0);
      if (appType === 6) return { kind: 'file', appType };
      if (appType === 5 || appType === 4) return { kind: 'link', appType };
      if (appType === 19) return { kind: 'link', appType }; // 合并转发的聊天记录
      if (appType === 57) return { kind: 'text', appType }; // 引用回复，正文在 title
      if (appType === 33 || appType === 36) return { kind: 'other', appType };
      return { kind: 'other', appType };
    }
    case 10000:
    case 10002:
      return { kind: 'system', appType: 0 };
    default:
      return { kind: 'other', appType: 0 };
  }
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
  'application/octet-stream': '.bin',
};

export class WcfAdapter implements WeChatAdapter {
  readonly name = 'wcf';
  private agent: AnyAgent | null = null;
  private connected = false;
  private selfInfo: { wxid: string; name: string } | null = null;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private eventHandler: ((ev: AdapterEvent) => void) | null = null;
  private contactNameCache = new Map<string, string>();
  private roomNameCache = new Map<string, string>();
  /** 消息 id -> 原始 WxMsg，下载附件时要用 */
  private rawStore = new Map<string, unknown>();

  async connect(): Promise<void> {
    let agentModule: { WechatferryAgent: new (opts?: Record<string, unknown>) => AnyAgent };
    try {
      agentModule = (await import('@wechatferry/agent')) as unknown as typeof agentModule;
    } catch (err) {
      throw new Error(
        `加载 @wechatferry/agent 失败：${(err as Error).message}\n` +
          '请确认已执行 npm install --ignore-scripts，且 node_modules 里有 @wechatferry/agent。',
      );
    }

    const Agent = agentModule.WechatferryAgent;
    const agent = new Agent({ keepalive: 30 });
    this.agent = agent;

    agent.on('login', (user: unknown) => {
      const u = user as { wxid?: string; name?: string };
      this.selfInfo = { wxid: u.wxid ?? agent.wcf.getSelfWxid(), name: u.name ?? '微信助手' };
      this.connected = true;
      log.info('微信登录成功', { wxid: this.selfInfo.wxid, name: this.selfInfo.name });
      this.eventHandler?.({ type: 'login', wxid: this.selfInfo.wxid, name: this.selfInfo.name });
    });

    agent.on('logout', () => {
      this.connected = false;
      log.warn('微信已退出登录');
      this.eventHandler?.({ type: 'logout', reason: '微信客户端退出登录' });
    });

    agent.on('error', (err: unknown) => {
      this.connected = false;
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('微信适配器错误', { err: error.message });
      this.eventHandler?.({ type: 'error', error });
    });

    agent.on('message', (msg: unknown) => {
      try {
        this.handleRaw(agent, msg as Record<string, unknown>);
      } catch (err) {
        log.error('处理原始消息失败', { err: (err as Error).message });
      }
    });

    try {
      agent.start();
    } catch (err) {
      throw new Error(
        `启动 WeChatFerry 失败：${(err as Error).message}\n` +
          '常见原因：微信没登录、微信版本不是 3.9.12.17、或被杀毒软件拦截了 DLL 注入。',
      );
    }
    log.info('WeChatFerry 已启动，等待登录事件…');
  }

  async disconnect(): Promise<void> {
    try {
      this.agent?.stop();
    } catch {
      /* ignore */
    }
    this.agent = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  self(): { wxid: string; name: string } | null {
    return this.selfInfo;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  onEvent(handler: (ev: AdapterEvent) => void): void {
    this.eventHandler = handler;
  }

  private handleRaw(agent: AnyAgent, raw: Record<string, unknown>): void {
    const type = Number(raw.type ?? 0);
    const isGroup = Boolean(raw.is_group);
    const isSelf = Boolean(raw.is_self);
    const id = String(raw.id ?? '');
    const xml = String(raw.xml ?? '');
    let content = String(raw.content ?? '');
    const sender = String(raw.sender ?? '');
    const chatId = isGroup ? String(raw.roomid ?? '') : sender || String(raw.roomid ?? '');
    const ts = Number(raw.ts ?? 0) * 1000 || Date.now();

    if (isSelf) return; // 自己发的（包括机器人自己）不处理，天然防复读
    if (!chatId || !id) return;

    const { kind, appType } = kindOf(type, xml);

    // @ 检测：WCF 的群消息在被 @ 时，正文以 "@昵称\u2005" 开头
    let isAtMe = false;
    if (isGroup) {
      const selfNames = new Set([this.selfInfo?.name ?? config.bot.name, config.bot.name, ...config.bot.aliases].filter(Boolean));
      const m = content.match(/^@([^\u2005\n]{1,40})\u2005?\s*/);
      if (m && m[1] && selfNames.has(m[1])) {
        isAtMe = true;
        content = content.slice(m[0].length);
      } else if ([...selfNames].some((n) => content.startsWith(`@${n}`))) {
        isAtMe = true;
        const n = [...selfNames].find((x) => content.startsWith(`@${x}`))!;
        content = content.slice(n.length + 1).replace(/^\u2005?\s*/, '');
      }
    }

    // 链接/文件消息正文在 XML 里
    let text = content;
    let media: IncomingMessage['media'] | undefined;
    if (type === 49) {
      const title = pickXmlTag(xml, 'title');
      const des = pickXmlTag(xml, 'des');
      const url = pickXmlTag(xml, 'url');
      const thumb = pickXmlTag(xml, 'thumburl');
      const filename = pickXmlTag(xml, 'title');
      if (kind === 'link') text = [title, des, url].filter(Boolean).join('\n');
      else if (kind === 'file') {
        text = filename || '（文件）';
        media = { name: filename, size: Number(pickXmlTag(xml, 'totallen') || 0) || undefined };
      } else text = title || content;
      if (thumb) media = { ...(media ?? {}), thumbUrl: thumb };
      if (url) media = { ...(media ?? {}), url };
    }

    const msg: IncomingMessage = {
      id,
      chatId,
      chatName: isGroup ? this.roomName(agent, chatId) : undefined,
      senderId: sender,
      senderName: this.contactName(agent, sender),
      isGroup,
      isSelf,
      isAtMe,
      kind,
      text: text.trim(),
      rawType: type,
      xml,
      media,
      ts,
    };
    if (!msg.text && kind !== 'text') msg.text = `（${kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'voice' ? '语音' : '消息'}）`;

    if (id) {
      this.rawStore.set(id, raw);
      if (this.rawStore.size > 500) {
        // 防止内存无限增长
        const k = this.rawStore.keys().next().value;
        if (k) this.rawStore.delete(k);
      }
    }

    log.debug('收到消息', {
      chat: msg.chatName ?? msg.chatId,
      from: msg.senderName,
      kind,
      appType,
      at: isAtMe,
      len: msg.text.length,
    });
    this.messageHandler?.(msg);
  }

  private contactName(agent: AnyAgent, wxid: string): string {
    if (!wxid) return '未知';
    const cached = this.contactNameCache.get(wxid);
    if (cached) return cached;
    try {
      const info = agent.getContactInfo(wxid);
      const name = info?.remark || info?.nickName || wxid;
      this.contactNameCache.set(wxid, name);
      return name;
    } catch {
      return wxid;
    }
  }

  private roomName(agent: AnyAgent, roomId: string): string {
    const cached = this.roomNameCache.get(roomId);
    if (cached) return cached;
    try {
      const info = agent.getChatRoomInfo(roomId);
      const name = info?.nickName || roomId;
      this.roomNameCache.set(roomId, name);
      return name;
    } catch {
      return roomId;
    }
  }

  async send(chatId: string, msg: Outgoing): Promise<void> {
    if (!this.agent) throw new Error('微信适配器未连接');
    if (msg.kind === 'text') {
      const code = this.agent.sendText(chatId, msg.text);
      if (code !== 0) throw new Error(`发送文本失败，返回码 ${code}`);
      return;
    }
    if (msg.kind === 'image') {
      const { FileBox } = (await import('file-box')) as unknown as { FileBox: { fromFile(p: string): unknown } };
      const code = await this.agent.sendImage(chatId, FileBox.fromFile(msg.path));
      if (code !== 0) throw new Error(`发送图片失败，返回码 ${code}`);
      return;
    }
    if (msg.kind === 'file') {
      const { FileBox } = (await import('file-box')) as unknown as { FileBox: { fromFile(p: string): unknown } };
      const code = await this.agent.sendFile(chatId, FileBox.fromFile(msg.path));
      if (code !== 0) throw new Error(`发送文件失败，返回码 ${code}`);
      return;
    }
    // 链接卡片
    const code = this.agent.sendRichText(chatId, {
      name: msg.sourceName ?? '哔哩哔哩',
      title: msg.title,
      digest: msg.digest ?? '',
      url: msg.url,
      thumburl: msg.thumbUrl ?? '',
    });
    if (code !== 0) throw new Error(`发送卡片失败，返回码 ${code}`);
  }

  async downloadMedia(msg: IncomingMessage): Promise<string | null> {
    const raw = this.rawStore.get(msg.id);
    if (!raw || !this.agent) return null;
    try {
      const box = await this.agent.downloadFile(raw, 30_000);
      const buf = await box.toBuffer();
      if (!buf || buf.length === 0) return null;
      const dir = config.storage.mediaDir;
      mkdirSync(dir, { recursive: true });
      const ext = EXT_BY_MIME[msg.media?.mime ?? ''] ?? (msg.kind === 'image' ? '.jpg' : msg.kind === 'voice' ? '.mp3' : '.mp4');
      const name = createHash('sha1').update(buf).digest('hex').slice(0, 20) + ext;
      const file = join(dir, name);
      writeFileSync(file, buf);
      log.debug('附件已保存', { file, size: buf.length });
      return file;
    } catch (err) {
      log.warn('下载附件失败', { err: (err as Error).message, kind: msg.kind });
      return null;
    }
  }
}
