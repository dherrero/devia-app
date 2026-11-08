import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGraphDb, type GraphDb } from './connection';
import { SCHEMA_VERSION } from './migrations';

const versions = (db: GraphDb): number[] =>
  (db.prepare('SELECT version FROM schema_versions ORDER BY version').all() as { version: number }[]).map((r) => r.version);
const hasIdFileIndex = (db: GraphDb): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_id_file'").get() !== undefined;

/** A graph as schema v1 left it: no `idx_nodes_id_file`, only version 1 recorded. */
function makeV1(file: string): void {
  const db = openGraphDb(file);
  db.exec('DROP INDEX idx_nodes_id_file');
  db.exec('DELETE FROM schema_versions WHERE version > 1');
  db.exec("INSERT INTO project_metadata VALUES ('k','v',1)");
  db.close();
}

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
    ).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('creates a new graph at the current schema version, with the id/file index', () => {
    const db = openGraphDb(path.join(dir, 'graph.db'));
    expect(SCHEMA_VERSION).toBe(2);
    expect(versions(db)).toEqual([1, 2]);
    expect(hasIdFileIndex(db)).toBe(true);
    db.close();
  });

  it('upgrades a v1 graph opened for write and keeps its data', () => {
    const file = path.join(dir, 'graph.db');
    makeV1(file);
    const db = openGraphDb(file);
    expect(versions(db)).toEqual([1, 2]);
    expect(hasIdFileIndex(db)).toBe(true);
    expect(db.prepare("SELECT value FROM project_metadata WHERE key = 'k'").get()).toEqual({ value: 'v' });
    db.close();
    const again = openGraphDb(file);
    expect(versions(again)).toEqual([1, 2]);
    again.close();
  });

  it('opens a v1 graph read-only without upgrading it', () => {
    const file = path.join(dir, 'graph.db');
    makeV1(file);
    const db = openGraphDb(file, { readonly: true });
    expect(versions(db)).toEqual([1]);
    expect(hasIdFileIndex(db)).toBe(false);
    expect(db.prepare("SELECT value FROM project_metadata WHERE key = 'k'").get()).toEqual({ value: 'v' });
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
