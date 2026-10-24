#!/usr/bin/env node
/**
 * 生成 .env（填 DeepSeek Key）。
 *
 * 用法：
 *   node configure.mjs sk-xxxxxxxx
 *
 * 做三件事：
 *   1. 从 env.example 复制一份 .env（已存在则保留其它配置）
 *   2. 把 DEEPSEEK_API_KEY 换成你给的值
 *   3. 用这个 Key 真调一次接口验证
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const key = (process.argv[2] ?? '').trim();

if (!key) {
  console.error('用法: node configure.mjs sk-你的Key');
  process.exit(1);
}
if (!key.startsWith('sk-')) {
  console.error('✖ DeepSeek 的 Key 一般以 sk- 开头，请确认没复制错。');
  process.exit(1);
}

const envPath = join(ROOT, '.env');
const examplePath = join(ROOT, 'env.example');

let text = '';
if (existsSync(envPath)) {
  text = readFileSync(envPath, 'utf8');
  console.log('[1/3] 已存在 .env，保留其它配置');
} else if (existsSync(examplePath)) {
  text = readFileSync(examplePath, 'utf8');
  console.log('[1/3] 从 env.example 生成 .env');
} else {
  text = 'DEEPSEEK_API_KEY=\n';
  console.log('[1/3] 没找到 env.example，写最小配置');
}

if (/^DEEPSEEK_API_KEY=.*$/m.test(text)) {
  text = text.replace(/^DEEPSEEK_API_KEY=.*$/m, `DEEPSEEK_API_KEY=${key}`);
} else {
  text = `DEEPSEEK_API_KEY=${key}\n` + text;
}
writeFileSync(envPath, text, 'utf8');
console.log('[2/3] 已写入 .env');

// 验证
process.env.DEEPSEEK_API_KEY = key;
try {
  const mod = await import('./src/llm/client.ts');
  const r = await mod.ping();
  if (r.ok) {
    console.log(`[3/3] ✔ Key 可用（${r.ms}ms，模型回复「${r.detail}」）`);
    console.log('\n完成。启动命令：');
    console.log('  node start.mjs --chat "群名A" --chat "群名B" --self-name "机器人昵称"');
  } else {
    console.error(`[3/3] ✖ Key 验证失败：${r.detail}`);
    process.exit(2);
  }
} catch (err) {
  console.error('[3/3] ✖ 验证请求异常：', err.message);
  process.exit(2);
}
