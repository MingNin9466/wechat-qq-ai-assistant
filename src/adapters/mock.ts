/**
 * 本地调试用的假微信适配器：
 * 不连微信、不需要小号，直接在控制台里和机器人对话，用来开发/演练业务逻辑。
 * 用法：npm run demo
 */
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createLogger } from '../infra/logger.ts';
import type { AdapterEvent, IncomingMessage, Outgoing, WeChatAdapter } from './types.ts';

const log = createLogger('adapter:mock');

export class MockAdapter implements WeChatAdapter {
  readonly name = 'mock';
  private connected = false;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private eventHandler: ((ev: AdapterEvent) => void) | null = null;
  private selfData = { wxid: 'wxid_mock_self', name: '小深' };
  private seq = 0;
  private rl: ReturnType<typeof createInterface> | null = null;
  /** 发送记录，测试用 */
  readonly sent: { chatId: string; text: string }[] = [];

  async connect(): Promise<void> {
    this.connected = true;
    log.info('已连接（模拟）', { self: this.selfData.name });
    this.eventHandler?.({ type: 'login', wxid: this.selfData.wxid, name: this.selfData.name });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.rl?.close();
    this.rl = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  self(): { wxid: string; name: string } {
    return this.selfData;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  onEvent(handler: (ev: AdapterEvent) => void): void {
    this.eventHandler = handler;
  }

  async send(chatId: string, msg: Outgoing): Promise<void> {
    if (msg.kind === 'text') {
      this.sent.push({ chatId, text: msg.text });
      console.log(`\n🤖 ${msg.text}\n`);
    } else if (msg.kind === 'link') {
      this.sent.push({ chatId, text: `[卡片] ${msg.title} -> ${msg.url}` });
      console.log(`\n🤖 [卡片] ${msg.title} -> ${msg.url}\n`);
    } else {
      console.log(`\n🤖 [${msg.kind}] ${'path' in msg ? msg.path : ''}\n`);
    }
  }

  /** 手动注入一条消息（测试用） */
  inject(text: string, opts: { chatId?: string; senderName?: string; isGroup?: boolean; isAtMe?: boolean } = {}): void {
    const msg: IncomingMessage = {
      id: `mock_${Date.now()}_${++this.seq}`,
      chatId: opts.chatId ?? 'room_test@chatroom',
      chatName: '测试群',
      senderId: 'wxid_friend_1',
      senderName: opts.senderName ?? '吴同学',
      isGroup: opts.isGroup ?? true,
      isSelf: false,
      isAtMe: opts.isAtMe ?? true,
      kind: 'text',
      text,
      rawType: 1,
      ts: Date.now(),
    };
    this.messageHandler?.(msg);
  }

  /** 进入交互式控制台循环 */
  async runConsole(): Promise<void> {
    this.rl = createInterface({ input, output });
    console.log('\n=== 本地模拟模式 ===');
    console.log('直接输入消息回车，机器人会像在群里一样回复。');
    console.log('命令：/help /reset /状态 ；输入 exit 退出\n');
    for (;;) {
      let line: string;
      try {
        line = (await this.rl.question('你 > ')).trim();
      } catch {
        break;
      }
      if (!line) continue;
      if (line === 'exit' || line === 'quit') break;
      this.inject(line);
      // 给处理器一点时间（真实场景是异步的，这里串行演示）
      await new Promise((r) => setTimeout(r, 50));
    }
    this.rl.close();
  }
}
