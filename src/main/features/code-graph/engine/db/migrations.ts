import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

function currentVersion(db: DatabaseSync): number {
  const table = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_versions'",
    )
    .get();
  if (!table) return 0;
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_versions')
    .get() as { v: number | null };
  return row.v ?? 0;
}

export function applyMigrations(db: DatabaseSync): void {
  if (currentVersion(db) >= SCHEMA_VERSION) return;
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql);
    db.prepare(
      'INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
    ).run(SCHEMA_VERSION, Date.now(), 'Initial schema');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
