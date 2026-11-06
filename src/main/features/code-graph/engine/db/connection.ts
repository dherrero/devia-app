import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrations';

export type GraphDb = DatabaseSync;

export function openGraphDb(
  file: string,
  opts: { readonly?: boolean } = {},
): GraphDb {
  const readOnly = opts.readonly === true;
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    applyMigrations(db);
  }
  return db;
}
