/**
 * 备份工具：`npm run backup`
 *  1) SQLite 在线快照到 backups/
 *  2) 导出一份人类可读的 JSONL（防"数据库坏了就全没了"）
 *  3) 清理超过保留份数的旧快照
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ensureDirs } from '../config.ts';
import { backupNow, closeDb, openDb, pruneBackups } from '../infra/db.ts';
import { beijingDate } from '../util.ts';

interface Row {
  [key: string]: unknown;
}

function exportJsonl(): { file: string; rows: number } {
  const db = openDb();
  const tables = ['messages', 'summaries', 'memories', 'diary', 'kv', 'usage'] as const;
  const dir = join(config.storage.dataDir, 'exports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `export-${beijingDate()}.jsonl`);
  let rows = 0;
  const lines: string[] = [];
  for (const table of tables) {
    const list = db.prepare(`SELECT * FROM ${table}`).all() as Row[];
    for (const r of list) {
      lines.push(JSON.stringify({ _table: table, ...r }));
      rows++;
    }
  }
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { file, rows };
}

function main(): void {
  ensureDirs();
  openDb();
  const file = backupNow('cli');
  const removed = pruneBackups(30);
  const exp = exportJsonl();
  console.log(`数据库快照：${file}`);
  console.log(`JSONL 导出：${exp.file}（${exp.rows} 行）`);
  console.log(`清理旧快照：${removed} 份`);
  closeDb();
}

main();
