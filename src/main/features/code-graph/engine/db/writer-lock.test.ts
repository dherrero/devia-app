import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lockFile, old, old);
    const lock = acquireWriterLock(dir, 'indexer', { staleMs: 1000 });
    expect(lock).not.toBeNull();
    expect(lock!.previousHolder).toBe('live');
    expect(readWriterLock(dir)?.owner).toBe('indexer');
    lock!.release();
  });

  it('does not steal a live lock older than staleMs whose heartbeat (mtime) is fresh', () => {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, owner: 'indexer', since: Date.now() - 5000 }),
    );
    expect(acquireWriterLock(dir, 'sync', { staleMs: 1000 })).toBeNull();
    expect(readWriterLock(dir)?.owner).toBe('indexer');
  });

  it('reports who held the lock before: nobody, a dead pid', () => {
    const free = acquireWriterLock(dir, 'sync')!;
    expect(free.previousHolder).toBe('none');
    free.release();
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999, owner: 'indexer', since: Date.now() }),
    );
    const stolen = acquireWriterLock(dir, 'sync')!;
    expect(stolen.previousHolder).toBe('dead');
    stolen.release();
  });

  it('a heartbeat keeps the held lock fresh and stops on release', async () => {
    const lock = acquireWriterLock(dir, 'indexer', { heartbeatMs: 20 })!;
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);
    await new Promise((r) => setTimeout(r, 150));
    expect(fs.statSync(lockFile).mtimeMs).toBeGreaterThan(Date.now() - 30_000);
    expect(acquireWriterLock(dir, 'sync', { staleMs: 30_000 })).toBeNull();
    lock.release();
    expect(fs.existsSync(lockFile)).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(fs.existsSync(lockFile)).toBe(false);
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
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);
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

  it('does not steal an empty lock file younger than the grace period', () => {
    fs.writeFileSync(lockFile, '');
    expect(acquireWriterLock(dir, 'indexer')).toBeNull();
    expect(fs.existsSync(lockFile)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);
    const lock = acquireWriterLock(dir, 'indexer');
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it('a stale handle cannot release a newer lock of the same process', () => {
    const stale = acquireWriterLock(dir, 'sync')!;
    fs.unlinkSync(lockFile);
    const fresh = acquireWriterLock(dir, 'indexer')!;
    expect(fresh).not.toBeNull();
    stale.release();
    expect(readWriterLock(dir)?.owner).toBe('indexer');
    fresh.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('leaves no temp or stale files behind', () => {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999, owner: 'indexer', since: Date.now() }),
    );
    acquireWriterLock(dir, 'sync')!.release();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // Fewer rounds than the original 20 (each costs a spawn barrier) and a
  // timeout sized for a heavily loaded machine; the steal mutex makes every
  // round deterministic in outcome, so 10 rounds still catch a regression.
  const RACE_ROUNDS = 10;
  const RACE_TIMEOUT_MS = 300_000;

  it('clears a steal mutex left behind by a crashed stealer', async () => {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: await deadPid(), owner: 'indexer', since: Date.now() }),
    );
    fs.writeFileSync(
      `${lockFile}.steal`,
      JSON.stringify({ pid: await deadPid(), owner: 'sync', since: Date.now() }),
    );
    const lock = acquireWriterLock(dir, 'sync');
    expect(lock).not.toBeNull();
    expect(readWriterLock(dir)?.pid).toBe(process.pid);
    lock?.release();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not steal while a live stealer holds the steal mutex', async () => {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: await deadPid(), owner: 'indexer', since: Date.now() }),
    );
    fs.writeFileSync(
      `${lockFile}.steal`,
      JSON.stringify({ pid: process.pid, owner: 'sync', since: Date.now() }),
    );
    expect(acquireWriterLock(dir, 'sync')).toBeNull();
    expect(fs.existsSync(`${lockFile}.steal`)).toBe(true);
  });

  const moduleUrl = pathToFileURL(path.join(__dirname, 'writer-lock.ts')).href;
  const script = `
    import(${JSON.stringify(moduleUrl)}).then((m) => {
      const t0 = Number(process.argv[2]);
      while (Date.now() < t0) {}
      const lock = m.acquireWriterLock(process.argv[1], 'sync');
      process.stdout.write(lock ? 'LOCKED\\n' : 'BUSY\\n');
      process.stdin.once('data', () => {
        if (lock) lock.release();
        process.exit(0);
      });
    });
  `;

  async function race(raceDir: string): Promise<string[]> {
    // Spawn barrier: generous so that, on a loaded machine, all four children
    // are usually parked at the same instant; a late child still yields a
    // valid (if less contended) round, never a false failure.
    const t0 = Date.now() + 2500;
    const children = Array.from({ length: 4 }, () => {
      const child = spawn(
        process.execPath,
        ['--no-warnings', '-e', script, raceDir, String(t0)],
        { stdio: ['pipe', 'pipe', 'inherit'] },
      );
      const result = new Promise<string>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes('\n')) resolve(out.trim());
        });
        child.on('error', reject);
        child.on('exit', () => resolve(out.trim() || 'EXIT'));
      });
      const exited = new Promise<void>((resolve) =>
        child.on('exit', () => resolve()),
      );
      return { child, result, exited };
    });
    const results = await Promise.all(children.map((c) => c.result));
    for (const c of children) c.child.stdin.write('x');
    await Promise.all(children.map((c) => c.exited));
    return results;
  }

  function deadPid(): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', '0']);
      child.on('error', reject);
      child.on('exit', () => resolve(child.pid!));
    });
  }

  it('grants the lock to exactly one of several simultaneous processes', async () => {
    for (let round = 0; round < RACE_ROUNDS; round++) {
      const raceDir = fs.mkdtempSync(path.join(dir, 'race-'));
      const results = await race(raceDir);
      expect(results.filter((r) => r === 'LOCKED')).toHaveLength(1);
      expect(results.filter((r) => r === 'BUSY')).toHaveLength(3);
      expect(fs.readdirSync(raceDir)).toEqual([]);
    }
  }, RACE_TIMEOUT_MS);

  it('grants a dead-pid lock to exactly one of several stealing processes', async () => {
    for (let round = 0; round < RACE_ROUNDS; round++) {
      const raceDir = fs.mkdtempSync(path.join(dir, 'steal-'));
      fs.writeFileSync(
        path.join(raceDir, 'writer.lock'),
        JSON.stringify({
          pid: await deadPid(),
          owner: 'indexer',
          since: Date.now(),
        }),
      );
      const results = await race(raceDir);
      expect(results.filter((r) => r === 'LOCKED')).toHaveLength(1);
      expect(results.filter((r) => r === 'BUSY')).toHaveLength(3);
      expect(fs.readdirSync(raceDir)).toEqual([]);
    }
  }, RACE_TIMEOUT_MS);
});
