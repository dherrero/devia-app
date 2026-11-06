import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGraphDb } from './connection';

describe('openGraphDb', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-db-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file in WAL mode with foreign keys on', () => {
    const file = path.join(dir, 'graph.db');
    const db = openGraphDb(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(
      (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string })
        .journal_mode,
    ).toBe('wal');
    expect(
      (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number })
        .foreign_keys,
    ).toBe(1);
    db.close();
  });

  it('does not re-apply the schema on reopen', () => {
    const file = path.join(dir, 'graph.db');
    openGraphDb(file).close();
    const db = openGraphDb(file);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS c FROM schema_versions').get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    db.close();
  });

  it('opens read-only without writing', () => {
    const file = path.join(dir, 'graph.db');
    openGraphDb(file).close();
    const db = openGraphDb(file, { readonly: true });
    expect(() =>
      db.exec("INSERT INTO project_metadata VALUES ('a','b',1)"),
    ).toThrow();
    db.close();
  });
});
