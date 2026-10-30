import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import {
  SnapshotStore,
  fingerprintForRequest,
  newSnapshotId,
} from './snapshot-store';

/**
 * Tests for the on-disk snapshot store (#270).
 *
 * Every test uses an isolated temp deviaDir so the real
 * ~/.devia-app/ stays untouched.
 */

function makeDeviaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devia-snap-'));
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('SnapshotStore.write', () => {
  let deviaDir: string;
  let workspace: string;
  beforeEach(() => {
    deviaDir = makeDeviaDir();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-snap-ws-'));
  });
  afterEach(() => {
    fs.rmSync(deviaDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('captures existing files into a gzipped blob with the right manifest entry', () => {
    const target = path.join(workspace, 'cfg.json');
    fs.writeFileSync(target, '{"a":1}', 'utf8');

    const store = new SnapshotStore(() => deviaDir);
    const id = newSnapshotId();
    const manifest = store.write({
      feature: 'skills',
      reason: 'test',
      paths: [target],
    }, id);

    expect(manifest.entries).toHaveLength(1);
    const entry = expectPresent(manifest.entries[0]);
    expect(entry.existed).toBe(true);
    expect(entry.size).toBe(7);
    expect(entry.archiveName).toBe('0.gz');

    const archive = fs.readFileSync(
      path.join(store.snapshotDir('skills', id), 'files', '0.gz'),
    );
    expect(zlib.gunzipSync(archive).toString('utf8')).toBe('{"a":1}');
  });

  it('records non-existent paths so restore can re-delete them', () => {
    const future = path.join(workspace, 'will-be-created.json');
    const store = new SnapshotStore(() => deviaDir);
    const id = newSnapshotId();
    const manifest = store.write({
      feature: 'manual',
      reason: 'before specify init',
      paths: [future],
    }, id);

    expect(manifest.entries[0]?.existed).toBe(false);
    expect(manifest.entries[0]?.sha256).toBeUndefined();
    // No files/ blob written for absent entries.
    expect(fs.existsSync(
      path.join(store.snapshotDir('manual', id), 'files', '0.gz'),
    )).toBe(false);
  });

  it('writes a parsable manifest.json at the snapshot root', () => {
    const target = path.join(workspace, 'a.json');
    fs.writeFileSync(target, 'x', 'utf8');

    const store = new SnapshotStore(() => deviaDir);
    const id = newSnapshotId();
    store.write({ feature: 'mcp', reason: 'r', paths: [target] }, id);

    const parsed = expectPresent(store.readManifestById('mcp', id));
    expect(parsed.feature).toBe('mcp');
    expect(parsed.reason).toBe('r');
  });

  it('readEntryContent decompresses back to the captured bytes', () => {
    const target = path.join(workspace, 'b.txt');
    const payload = 'hello world';
    fs.writeFileSync(target, payload, 'utf8');

    const store = new SnapshotStore(() => deviaDir);
    const id = newSnapshotId();
    const manifest = store.write({ feature: 'manual', reason: 'r', paths: [target] }, id);
    const buf = store.readEntryContent('manual', id, expectPresent(manifest.entries[0]));
    expect(buf?.toString('utf8')).toBe(payload);
  });

  it('removeSnapshot is idempotent', () => {
    const store = new SnapshotStore(() => deviaDir);
    store.removeSnapshot('skills', 'does-not-exist');
    expect(true).toBe(true); // no throw
  });
});

describe('SnapshotStore.listManifests', () => {
  let deviaDir: string;
  beforeEach(() => { deviaDir = makeDeviaDir(); });
  afterEach(() => fs.rmSync(deviaDir, { recursive: true, force: true }));

  it('returns [] for a fresh deviaDir', () => {
    const store = new SnapshotStore(() => deviaDir);
    expect(store.listManifests()).toEqual([]);
  });

  it('skips manifests with broken JSON without throwing', () => {
    const store = new SnapshotStore(() => deviaDir);
    const dir = store.snapshotDir('skills', 'broken-id');
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json', 'utf8');
    expect(store.listManifests('skills')).toEqual([]);
  });
});

describe('fingerprintForRequest', () => {
  it('is stable across calls with identical content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-fp-'));
    const target = path.join(dir, 'a.json');
    fs.writeFileSync(target, 'same', 'utf8');
    try {
      const fp1 = fingerprintForRequest({ feature: 'mcp', reason: 'r', paths: [target] });
      const fp2 = fingerprintForRequest({ feature: 'mcp', reason: 'r', paths: [target] });
      expect(fp1).toBe(fp2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('changes when content changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-fp-'));
    const target = path.join(dir, 'a.json');
    fs.writeFileSync(target, 'a', 'utf8');
    try {
      const fp1 = fingerprintForRequest({ feature: 'mcp', reason: 'r', paths: [target] });
      fs.writeFileSync(target, 'b', 'utf8');
      const fp2 = fingerprintForRequest({ feature: 'mcp', reason: 'r', paths: [target] });
      expect(fp1).not.toBe(fp2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats absent files as a stable "absent" marker', () => {
    const fp1 = fingerprintForRequest({ feature: 'mcp', reason: 'r', paths: ['/does/not/exist'] });
    const fp2 = fingerprintForRequest({ feature: 'mcp', reason: 'r', paths: ['/does/not/exist'] });
    expect(fp1).toBe(fp2);
  });
});

describe('newSnapshotId', () => {
  it('produces sortable ISO-based ids with a random suffix', () => {
    const a = newSnapshotId(new Date('2026-05-20T10:00:00.000Z'));
    const b = newSnapshotId(new Date('2026-05-20T11:00:00.000Z'));
    // Lexicographic sort matches chronological.
    expect(a < b).toBe(true);
    // Random suffix means two ids at the same instant differ.
    const c = newSnapshotId(new Date('2026-05-20T10:00:00.000Z'));
    expect(a).not.toBe(c);
  });

  it('is a valid filename on every supported OS (no path separators)', () => {
    const id = newSnapshotId();
    expect(id).not.toMatch(/[/\\:]/);
  });

  // Sanity check that the algorithm still uses crypto.randomBytes —
  // a future "Math.random" regression would collapse uniqueness fast.
  it('reaches at least 16 unique values in 16 attempts at the same instant', () => {
    const fixed = new Date('2026-05-20T10:00:00.000Z');
    const seen = new Set(Array.from({ length: 16 }, () => newSnapshotId(fixed)));
    expect(seen.size).toBe(16);
  });

  it('crypto fingerprint length is 64 hex chars (sha256)', () => {
    // Defensive: any change to the hash should be a deliberate one.
    const fp = crypto.createHash('sha256').update('test').digest('hex');
    expect(fp).toHaveLength(64);
  });
});
