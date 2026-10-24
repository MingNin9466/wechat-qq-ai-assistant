/**
 * 微信适配层的统一模型。
 * 业务代码只认这里的类型，换微信接入方式（wcf / wxauto / 企业微信）不用改业务。
 */

export type MessageKind =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'link'
  | 'emoticon'
  | 'system'
  | 'other';

export interface MediaRef {
  /** 本地已下载路径 */
  path?: string;
  /** 原始远程地址（可能过期） */
  url?: string;
  thumbUrl?: string;
  name?: string;
  size?: number;
  mime?: string;
}

export interface IncomingMessage {
  /** 平台消息 id（用于去重） */
  id: string;
  /** 群 id 或私聊 wxid */
  chatId: string;
  chatName?: string;
  senderId: string;
  senderName: string;
  isGroup: boolean;
  isSelf: boolean;
  /** 是否 @ 了机器人（群聊） */
  isAtMe: boolean;
  kind: MessageKind;
  /** 去掉 @ 前缀后的纯文本 */
  text: string;
  rawType: number;
  xml?: string;
  media?: MediaRef;
  ts: number;
}

export interface OutgoingText {
  kind: 'text';
  text: string;
}

export interface OutgoingImage {
  kind: 'image';
  path: string;
}

export interface OutgoingLink {
  kind: 'link';
  title: string;
  digest?: string;
  url: string;
  thumbUrl?: string;
  sourceName?: string;
}

export interface OutgoingFile {
  kind: 'file';
  path: string;
  name?: string;
}

export type Outgoing = OutgoingText | OutgoingImage | OutgoingLink | OutgoingFile;

export type AdapterEvent =
  | { type: 'login'; wxid: string; name: string }
  | { type: 'logout'; reason?: string }
  | { type: 'error'; error: Error }
  | { type: 'status'; connected: boolean; detail?: string };

export interface WeChatAdapter {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(chatId: string, msg: Outgoing): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  onEvent(handler: (ev: AdapterEvent) => void): void;
  self(): { wxid: string; name: string } | null;
  /** 下载语音/视频/文件到本地，返回路径 */
  downloadMedia?(msg: IncomingMessage): Promise<string | null>;
  /** 用户是否正在用全屏程序（游戏/视频）——有的话就别抢窗口 */
  isUserBusy?(): Promise<{ busy: boolean; title?: string; exe?: string }>;
  /** 发一张图片/表情包 */
  sendImage?(chatId: string, path: string): Promise<boolean>;
  /** 发一个文件（语音 mp3 等） */
  sendFile?(chatId: string, path: string): Promise<boolean>;
  /** 发真正的语音消息（QQ 支持 record 段；微信只能发文件） */
  sendVoice?(chatId: string, path: string): Promise<boolean>;
  isConnected(): boolean;
}

/** 从微信 XML 里抠出字段（不引 XML 解析库，够用） */
export function pickXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  if (!m?.[1]) return '';
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}
