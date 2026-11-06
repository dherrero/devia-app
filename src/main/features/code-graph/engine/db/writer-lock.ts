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

const ownedFiles = new Set<string>();
let exitHookRegistered = false;

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on('exit', () => {
    for (const file of ownedFiles) removeIfOurs(file);
  });
}

function readFile(file: string): WriterLockInfo | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const { pid, owner, since } = raw as Record<string, unknown>;
    if (
      typeof pid !== 'number' ||
      typeof since !== 'number' ||
      (owner !== 'indexer' && owner !== 'sync')
    ) {
      return null;
    }
    return { pid, owner, since };
  } catch {
    return null;
  }
}

function removeIfOurs(file: string): void {
  if (readFile(file)?.pid !== process.pid) return;
  try {
    fs.unlinkSync(file);
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

function writeNew(file: string, info: WriterLockInfo): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(info));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

export function readWriterLock(dir: string): WriterLockInfo | null {
  return readFile(path.join(dir, LOCK_NAME));
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
  const info: WriterLockInfo = { pid: process.pid, owner, since: Date.now() };

  if (!writeNew(file, info)) {
    const current = readFile(file);
    const stale =
      current === null ||
      !isAlive(current.pid) ||
      Date.now() - current.since > staleMs;
    if (!stale) return null;
    fs.writeFileSync(file, JSON.stringify(info));
    const confirmed = readFile(file);
    if (confirmed?.pid !== process.pid || confirmed.since !== info.since) {
      return null;
    }
  }

  ownedFiles.add(file);
  registerExitHook();
  return {
    release(): void {
      ownedFiles.delete(file);
      removeIfOurs(file);
    },
  };
}
