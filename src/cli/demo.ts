/**
 * 本地模拟：`npm run demo`
 * 不连微信、不需要小号，直接在控制台里和机器人对话，用来调业务逻辑。
 * 没有 API Key 时自动进入离线模拟（假回复），有 Key 就是真调用（会花钱，注意）。
 */
import { MockAdapter } from '../adapters/mock.ts';
import { config, ensureDirs } from '../config.ts';
import { Dispatcher } from '../core/dispatcher.ts';
import { closeDb, openDb } from '../infra/db.ts';
import { attachLogSink, configureLogger, createLogger } from '../infra/logger.ts';
import { addLogRow } from '../memory/store.ts';

const log = createLogger('demo');

async function main(): Promise<void> {
  ensureDirs();
  configureLogger({ level: 'info', pretty: true });
  openDb();
  attachLogSink(addLogRow);

  if (!config.deepseek.apiKey) {
    process.env.MOCK_LLM = '1';
    log.warn('没有检测到 DEEPSEEK_API_KEY，进入离线模拟模式（回复是假的）');
  }

  const adapter = new MockAdapter();
  const dispatcher = new Dispatcher(adapter);
  dispatcher.start();
  await adapter.connect();

  console.log('提示：机器人名字是「' + config.bot.name + '」，触发模式 ' + config.bot.triggerMode);
  console.log('试试：你好 / /help / /记住 每周三开组会 / /状态\n');

  await adapter.runConsole();

  console.log('\n收尾：');
  console.log(JSON.stringify(dispatcher.getStats(), null, 2));
  await adapter.disconnect();
  closeDb();
  process.exit(0);
}

void main();
