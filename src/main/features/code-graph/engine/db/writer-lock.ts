import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type WriterOwner = 'indexer' | 'sync';

export interface WriterLockInfo {
  pid: number;
  owner: WriterOwner;
  since: number;
}

export interface WriterLock {
  release(): void;
}

const LOCK_NAME = 'writer.lock';
const DEFAULT_STALE_MS = 30 * 60 * 1000;

const STALE_UNPARSEABLE_GRACE_MS = 2000;
const MAX_ATTEMPTS = 3;

interface OwnedLock {
  file: string;
  token: string;
}

const owned = new Set<OwnedLock>();
let exitHookRegistered = false;

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on('exit', () => {
    for (const lock of owned) removeIfOurs(lock);
  });
}

function parse(raw: string): (WriterLockInfo & { token?: string }) | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { pid, owner, since, token } = value as Record<string, unknown>;
    if (
      typeof pid !== 'number' ||
      typeof since !== 'number' ||
      (owner !== 'indexer' && owner !== 'sync')
    ) {
      return null;
    }
    return typeof token === 'string'
      ? { pid, owner, since, token }
      : { pid, owner, since };
  } catch {
    return null;
  }
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readFile(file: string) {
  const raw = readRaw(file);
  return raw === null ? null : parse(raw);
}

function removeIfOurs(lock: OwnedLock): void {
  const current = readFile(lock.file);
  if (current?.pid !== process.pid || current.token !== lock.token) return;
  try {
    fs.unlinkSync(lock.file);
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function uniqueSuffix(): string {
  return `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

function createExclusive(file: string, payload: string): boolean {
  const tmp = `${file}.tmp-${uniqueSuffix()}`;
  try {
    fs.writeFileSync(tmp, payload, { flag: 'wx' });
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'ENOSYS' && code !== 'EPERM' && code !== 'ENOTSUP') throw err;
    // Filesystem without hard links: fall back to O_EXCL create (the file is
    // briefly empty, which readers cover with the unparseable-lock grace).
    try {
      fs.writeFileSync(file, payload, { flag: 'wx' });
      return true;
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw inner;
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}

function isStale(file: string, raw: string | null, staleMs: number): boolean {
  const info = raw === null ? null : parse(raw);
  if (info !== null) {
    return !isAlive(info.pid) || Date.now() - info.since > staleMs;
  }
  try {
    return Date.now() - fs.statSync(file).mtimeMs > STALE_UNPARSEABLE_GRACE_MS;
  } catch {
    return false;
  }
}

export function readWriterLock(dir: string): WriterLockInfo | null {
  const info = readFile(path.join(dir, LOCK_NAME));
  return info === null
    ? null
    : { pid: info.pid, owner: info.owner, since: info.since };
}

export function isFullIndexRunning(dir: string): boolean {
  const info = readWriterLock(dir);
  return info !== null && info.owner === 'indexer' && isAlive(info.pid);
}

export function acquireWriterLock(
  dir: string,
  owner: WriterOwner,
  opts: { staleMs?: number } = {},
): WriterLock | null {
  const file = path.join(dir, LOCK_NAME);
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const token = crypto.randomBytes(8).toString('hex');
  const payload = JSON.stringify({
    pid: process.pid,
    owner,
    since: Date.now(),
    token,
  });

  let acquired = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !acquired; attempt++) {
    if (createExclusive(file, payload)) {
      acquired = true;
      break;
    }
    const raw = readRaw(file);
    if (raw === null) continue;
    if (!isStale(file, raw, staleMs)) return null;

    const graveyard = `${file}.stale-${uniqueSuffix()}`;
    try {
      fs.renameSync(file, graveyard);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      if (code === 'EBUSY' || code === 'EPERM') return null;
      throw err;
    }
    if (readRaw(graveyard) !== raw) {
      // We moved a lock that was replaced after we judged it stale: put it
      // back. A narrow three-process interleaving can still yield two holders
      // here; accepted because graph.db (WAL + busy_timeout) serialises the
      // real writes, so a double holder costs a redundant run, not corruption.
      try {
        fs.linkSync(graveyard, file);
      } catch {
        // someone else already holds a newer lock
      }
      fs.rmSync(graveyard, { force: true });
      return null;
    }
    fs.rmSync(graveyard, { force: true });
  }
  if (!acquired) return null;

  const handle: OwnedLock = { file, token };
  owned.add(handle);
  registerExitHook();
  return {
    release(): void {
      owned.delete(handle);
      removeIfOurs(handle);
    },
  };
}
