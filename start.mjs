#!/usr/bin/env node
/**
 * 一键启动：桥接进程（Python）+ 机器人（Node）。
 *
 * 用法：
 *   node start.mjs --chat "群B" --self-name "小助手"
 *
 * 可选：
 *   --fallback-focus   UIA 发送失败时允许回退到模拟输入（会抢键鼠）
 *   --mock-llm         用假模型跑通链路（不花钱，回复内容是假的）
 *
 * 停止：Ctrl+C（两个进程会一起退出）
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const PY_CANDIDATES = [
  process.env.PYTHON,
  'D:\\PyBot\\python.exe',
  'C:\\Python312\\python.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe'),
];

function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  }
  return out;
}
function arg(name, def) {
  const all = argAll(name);
  return all.length ? all[all.length - 1] : def;
}
const has = (name) => process.argv.includes(name);

// 支持：--chat "群A" --chat "群B"  或  --chats "群A,群B"
const chats = [
  ...argAll('--chat'),
  ...(arg('--chats', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
].filter(Boolean);
const selfName = arg('--self-name', '');
if (!chats.length) {
  console.error('用法: node start.mjs --chat "群A" --chat "群B" [--self-name "机器人昵称"] [--fallback-focus]');
  process.exit(1);
}

const py = PY_CANDIDATES.find((p) => p && existsSync(p));
if (!py) {
  console.error('✖ 找不到 Python（D:\\PyBot\\python.exe）。请装好或设环境变量 PYTHON。');
  process.exit(1);
}

const BRIDGE_PORT = process.env.BRIDGE_PORT ?? '8899';
const children = [];
let stopping = false;

function tag(prefix, stream, data) {
  const text = String(data);
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) console.log(`${prefix} ${line}`);
  }
}

function startBridge() {
  const args = ['bridge/wechat_bridge.py', '--port', BRIDGE_PORT];
  for (const c of chats) args.push('--chat', c);
  if (selfName) args.push('--self-name', selfName);
  if (has('--fallback-focus')) args.push('--fallback-focus');
  console.log(`[启动] 桥接：${py} ${args.join(' ')}`);
  const p = spawn(py, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  p.stdout.on('data', (d) => tag('[桥接]', p.stdout, d));
  p.stderr.on('data', (d) => tag('[桥接]', p.stderr, d));
  p.on('exit', (code) => {
    console.log(`[桥接] 退出 code=${code}`);
    if (!stopping) shutdown(1);
  });
  children.push(p);
  return p;
}

async function waitHealth(timeoutMs = 30000) {
  const url = `http://127.0.0.1:${BRIDGE_PORT}/health`;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function startBot() {
  const args = ['src/main.ts', '--adapter=wxauto'];
  // 透传 QQ 开关
  if (has('--qq') || process.env.QQ_ENABLED === '1') args.push('--qq');
  console.log(`[启动] 机器人：node ${args.join(' ')}`);
  const env = { ...process.env };
  if (has('--mock-llm')) env.MOCK_LLM = '1';
  const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  p.stdout.on('data', (d) => tag('[机器人]', p.stdout, d));
  p.stderr.on('data', (d) => tag('[机器人]', p.stderr, d));
  p.on('exit', (code) => {
    console.log(`[机器人] 退出 code=${code}`);
    if (!stopping) shutdown(1);
  });
  children.push(p);
  return p;
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  console.log('\n[收尾] 正在停止…');
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 800);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('='.repeat(50));
console.log(`目标群：${chats.join('、')}`);
console.log(`昵称：  ${selfName || '(自动取微信昵称)'}`);
console.log('='.repeat(50));

startBridge();

const health = await waitHealth();
if (!health) {
  console.error('✖ 桥接进程 30 秒内没起来，检查上面的报错。');
  shutdown(1);
} else {
  const watching = (health.chats || [health.chat]).filter(Boolean);
  console.log(`[就绪] 桥接 ${health.package}，登录账号：${health.self}，正在盯：${watching.join('、') || '(无)'}`);
  if (watching.length < chats.length) {
    console.log('[提醒] 有群没盯上（名字对不上），看上面桥接日志里的报错。');
  }
  if (!existsSync(join(ROOT, '.env'))) {
    console.log('[提醒] 没有找到 .env，机器人将无法调用 DeepSeek。先填 DEEPSEEK_API_KEY。');
  }
  startBot();
  console.log('[运行中] 在群里 @ 机器人试试；Ctrl+C 停止。\n');
}
