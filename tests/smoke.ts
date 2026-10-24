/**
 * 冒烟测试：不连微信、不花钱，验证「消息进来 → 指令/对话 → 落库」整条链路。
 * 运行：node tests/smoke.ts
 */
import { rmSync } from 'node:fs';

async function main(): Promise<void> {
  // 必须在 import 业务模块之前设置环境变量（config 在模块加载时读取）
  process.env.MOCK_LLM = '1';
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = 'data/test';
  process.env.QUIET_ENABLED = 'false';
  process.env.MIN_DELAY_MS = '0';
  process.env.MAX_DELAY_MS = '1';
  process.env.SEGMENT_DELAY_MS = '1';
  process.env.LOG_LEVEL = 'warn';
  process.env.LOG_TO_DB = 'false';
  process.env.TRIGGER_MODE = 'at';
  delete process.env.DEEPSEEK_API_KEY;

  // 清掉上次的测试库
  for (const f of ['data/test/bot.sqlite', 'data/test/bot.sqlite-wal', 'data/test/bot.sqlite-shm']) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }

  const { MockAdapter } = await import('../src/adapters/mock.ts');
  const { Dispatcher } = await import('../src/core/dispatcher.ts');
  const { openDb, closeDb, healthCheck } = await import('../src/infra/db.ts');
  const { getRecentMessages, statsFor } = await import('../src/memory/store.ts');

  openDb();
  const adapter = new MockAdapter();
  const dispatcher = new Dispatcher(adapter);
  dispatcher.start();
  await adapter.connect();

  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 1. 普通对话
  adapter.sent.length = 0;
  adapter.inject('你好呀，介绍下你自己');
  await sleep(2500);
  check('对话有回复', adapter.sent.length > 0, adapter.sent[0]?.text.slice(0, 40));
  check('走的是模拟模型', (adapter.sent[0]?.text ?? '').includes('[离线模拟]'));

  // 2. /help
  adapter.sent.length = 0;
  adapter.inject('/help');
  await sleep(300);
  check('/help 有回复', (adapter.sent[0]?.text ?? '').includes('我能干这些事'));

  // 3. /记住
  adapter.sent.length = 0;
  adapter.inject('/记住 每周三晚上8点开组会');
  await sleep(300);
  check('/记住 写入成功', (adapter.sent[0]?.text ?? '').includes('记下了'));

  // 4. /记忆
  adapter.sent.length = 0;
  adapter.inject('/记忆 组会');
  await sleep(300);
  check('/记忆 能检索到', (adapter.sent[0]?.text ?? '').includes('组会'));

  // 5. /状态
  adapter.sent.length = 0;
  adapter.inject('/状态');
  await sleep(300);
  check('/状态 正常', (adapter.sent[0]?.text ?? '').includes('本群'));

  // 6. 没 @ 机器人时不该回复
  adapter.sent.length = 0;
  adapter.inject('今天食堂吃什么', { isAtMe: false });
  await sleep(600);
  check('未 @ 时不回复', adapter.sent.length === 0, `实际发了 ${adapter.sent.length} 条`);

  // 7. 消息落库
  const recent = getRecentMessages('room_test@chatroom', 20);
  check('消息已落库', recent.length >= 6, `库里 ${recent.length} 条`);
  check('库里同时有 user 和 assistant', recent.some((m) => m.role === 'user') && recent.some((m) => m.role === 'assistant'));

  // 8. 统计
  const stats = statsFor('room_test@chatroom');
  check('记忆已持久化', stats.memories >= 1, `${stats.memories} 条`);
  check('摘要表可访问', stats.summaries >= 0);

  // 9. 数据库完整性
  const h = healthCheck();
  check('数据库完整性', h.ok, h.integrity);

  // 10. 调度统计
  const st = dispatcher.getStats();
  check('调度统计合理', st.received >= 6 && st.replied >= 5, `收到 ${st.received}，回复 ${st.replied}，跳过 ${st.skipped}`);

  await adapter.disconnect();
  closeDb();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exit(1);
  }
  console.log('冒烟测试全部通过 ✅');
}

void main().catch((err) => {
  console.error('测试崩溃：', err);
  process.exit(1);
});
