import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireWriterLock,
  isFullIndexRunning,
  readWriterLock,
} from './writer-lock';

describe('writer-lock', () => {
  let dir: string;
  let lockFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-'));
    lockFile = path.join(dir, 'writer.lock');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null on a second acquire and allows reacquire after release', () => {
    const first = acquireWriterLock(dir, 'indexer');
    expect(first).not.toBeNull();
    expect(acquireWriterLock(dir, 'sync')).toBeNull();
    first!.release();
    const again = acquireWriterLock(dir, 'sync');
    expect(again).not.toBeNull();
    again!.release();
  });

  it('release is idempotent and does not remove a lock owned by someone else', () => {
    const lock = acquireWriterLock(dir, 'indexer')!;
    lock.release();
    lock.release();
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid + 1,
        owner: 'sync',
        since: Date.now(),
      }),
    );
    lock.release();
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it('steals a lock whose pid does not exist', () => {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999, owner: 'indexer', since: Date.now() }),
    );
    const lock = acquireWriterLock(dir, 'sync');
    expect(lock).not.toBeNull();
    expect(readWriterLock(dir)?.pid).toBe(process.pid);
    lock!.release();
  });

  it('steals a live lock older than staleMs', () => {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        owner: 'sync',
        since: Date.now() - 5000,
      }),
    );
    const lock = acquireWriterLock(dir, 'indexer', { staleMs: 1000 });
    expect(lock).not.toBeNull();
    expect(readWriterLock(dir)?.owner).toBe('indexer');
    lock!.release();
  });

  it('does not steal a fresh live lock', () => {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, owner: 'sync', since: Date.now() }),
    );
    expect(acquireWriterLock(dir, 'indexer')).toBeNull();
  });

  it('isFullIndexRunning is true only for a live indexer', () => {
    expect(isFullIndexRunning(dir)).toBe(false);
    const sync = acquireWriterLock(dir, 'sync')!;
    expect(isFullIndexRunning(dir)).toBe(false);
    sync.release();
    const indexer = acquireWriterLock(dir, 'indexer')!;
    expect(isFullIndexRunning(dir)).toBe(true);
    indexer.release();
    expect(isFullIndexRunning(dir)).toBe(false);
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999, owner: 'indexer', since: Date.now() }),
    );
    expect(isFullIndexRunning(dir)).toBe(false);
  });

  it('readWriterLock returns null for missing or corrupt files', () => {
    expect(readWriterLock(dir)).toBeNull();
    fs.writeFileSync(lockFile, '{not json');
    expect(readWriterLock(dir)).toBeNull();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 'x' }));
    expect(readWriterLock(dir)).toBeNull();
  });

  it('steals a corrupt lock file', () => {
    fs.writeFileSync(lockFile, 'garbage');
    const lock = acquireWriterLock(dir, 'indexer');
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it('does not leak exit listeners across acquire/release cycles', () => {
    const l0 = acquireWriterLock(dir, 'sync')!;
    l0.release();
    const before = process.listenerCount('exit');
    for (let i = 0; i < 20; i++) {
      acquireWriterLock(dir, 'sync')!.release();
    }
    expect(process.listenerCount('exit')).toBe(before);
  });
});
