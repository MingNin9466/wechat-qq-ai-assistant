/**
 * 记忆蒸馏工具（手动触发 / 排查用）
 *
 * 用法：
 *   node src/cli/distill.ts --chat "群B"                  # 有足够消息就蒸馏一次
 *   node src/cli/distill.ts --chat "群B" --force          # 有几条就压几条
 *   node src/cli/distill.ts --chat "群B" --diary 2026-10-23
 *   node src/cli/distill.ts --chat "群B" --facts
 *   node src/cli/distill.ts --chat "群B" --all            # 蒸馏 + 今日日记 + 抽记忆
 */
import { config, ensureDirs } from '../config.ts';
import { closeDb, openDb } from '../infra/db.ts';
import { attachLogSink, configureLogger } from '../infra/logger.ts';
import { addLogRow, listMemories } from '../memory/store.ts';
import { distillSession, extractMemories, makeDiary } from '../memory/distill.ts';
import { beijingDate } from '../util.ts';

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(name);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v ?? def;
}
const has = (n: string) => process.argv.includes(n);

async function main(): Promise<void> {
  ensureDirs();
  configureLogger({ level: 'info', pretty: true });
  openDb();
  attachLogSink(addLogRow);

  if (!config.deepseek.apiKey) {
    console.error('✖ 没有配置 DEEPSEEK_API_KEY，无法蒸馏（先 node configure.mjs sk-xxx）');
    process.exit(1);
  }

  const chatId = arg('--chat');
  if (!chatId) {
    console.error('用法: node src/cli/distill.ts --chat "群名" [--force] [--diary YYYY-MM-DD] [--facts] [--all]');
    process.exit(1);
  }

  const all = has('--all');
  let code = 0;

  if (all || has('--force') || (!has('--diary') && !has('--facts'))) {
    const r = await distillSession(chatId, { force: has('--force') });
    console.log(r.ok ? `✔ 摘要 #${r.summaryId}（用了 ${r.usedMessages} 条消息）` : `- 跳过蒸馏：${r.reason}`);
    if (!r.ok && !all) code = 0;
  }

  if (all || has('--diary')) {
    const date = arg('--diary', beijingDate());
    const r = await makeDiary(chatId, date);
    console.log(r.ok ? `✔ 日记 ${date} 已生成` : `- 跳过日记：${r.reason}`);
  }

  if (all || has('--facts')) {
    const r = await extractMemories(chatId);
    console.log(r.ok ? `✔ 抽取长期记忆 ${r.added} 条` : `- 跳过抽取：${r.reason}`);
  }

  const mems = listMemories(chatId, 10);
  if (mems.length) {
    console.log('\n当前记忆（最近 10 条）：');
    for (const m of mems) console.log(`  #${m.id} ${m.pinned ? '📌' : ' '} ${m.content}`);
  }

  closeDb();
  process.exit(code);
}

void main().catch((err) => {
  console.error('蒸馏失败：', err);
  process.exit(1);
});
