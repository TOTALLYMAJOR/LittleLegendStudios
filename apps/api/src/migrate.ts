import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './db.js';

async function run(): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const migrationFile = resolve(currentDir, '../../../infra/sql/001_init.sql');
  const sql = await readFile(migrationFile, 'utf8');

  await pool.query(sql);
  await pool.end();

  process.stdout.write(`Applied migration: ${migrationFile}\n`);
}

run().catch((error) => {
  process.stderr.write(`Migration failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
