import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  description: string;
  up(db: DatabaseSync): void;
}

// Every step must be idempotent: v1 runs schema.sql, which already holds the later
// indexes, so a new graph runs the later steps as no-ops.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema',
    up: (db) => db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')),
  },
  {
    version: 2,
    description: 'Graph view id/file index',
    up: (db) => db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_id_file ON nodes(id, file_path)'),
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

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
  db.exec('BEGIN IMMEDIATE');
  try {
    const from = currentVersion(db);
    for (const m of MIGRATIONS) {
      if (m.version <= from) continue;
      m.up(db);
      db.prepare(
        'INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
      ).run(m.version, Date.now(), m.description);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
