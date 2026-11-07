import * as fs from 'node:fs';
import * as path from 'node:path';
import { createIgnore } from '../engine/discovery/ignore';

export const DEFAULT_DEBOUNCE_MS = 800;
export const MAX_BATCH = 5000;
export const MAX_WATCHED_DIRS = 2000;

export interface WatcherHandle {
  close(): void;
}

export interface RawWatcher {
  close(): void;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

export type WatchFn = (
  dir: string,
  opts: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => RawWatcher;

export interface FileWatcherOptions {
  debounceMs?: number;
  maxDirs?: number;
  watchFn?: WatchFn;
  readdirFn?: (dir: string) => fs.Dirent[];
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onError?: (err: unknown) => void;
  /** The per-directory fallback could not cover the whole tree. */
  onDegraded?: () => void;
}

const defaultWatch: WatchFn = (dir, opts, listener) =>
  fs.watch(dir, { recursive: opts.recursive }, (event, filename) => listener(event, filename));

/**
 * Debounced, filtered watcher over a project tree. Batches are root-relative `/` paths;
 * `overflow` means too many changes to list and the caller should sync the whole tree.
 */
export function createFileWatcher(
  root: string,
  isRelevant: (rel: string) => boolean,
  onChange: (rels: string[], overflow: boolean) => void,
  opts: FileWatcherOptions = {},
): WatcherHandle {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxDirs = opts.maxDirs ?? MAX_WATCHED_DIRS;
  const watchFn = opts.watchFn ?? defaultWatch;
  const readdir = opts.readdirFn ?? ((dir: string) => fs.readdirSync(dir, { withFileTypes: true }));
  const setTimer = opts.setTimeoutFn ?? setTimeout;
  const clearTimer = opts.clearTimeoutFn ?? clearTimeout;
  const reportError = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // the error sink must not break the watcher
    }
  };
  const ignored = createIgnore(root);

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = new Set<string>();
  let overflow = false;
  const watchers = new Map<string, RawWatcher>();

  const flush = (): void => {
    timer = undefined;
    if (closed) return;
    const paths = [...pending];
    const over = overflow;
    pending = new Set();
    overflow = false;
    if (!over && paths.length === 0) return;
    try {
      onChange(over ? [] : paths, over);
    } catch (err) {
      reportError(err);
    }
  };

  const record = (rel: string): void => {
    if (pending.size >= MAX_BATCH) {
      overflow = true;
      pending = new Set();
    }
    if (!overflow) pending.add(rel);
  };

  const accept = (rel: string): void => {
    if (!isRelevant(rel) || ignored(rel, false)) return;
    record(rel);
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(flush, debounceMs);
    timer.unref?.();
  };

  const toRel = (dir: string, filename: string): string => {
    const abs = path.isAbsolute(filename) ? filename : path.join(dir, filename);
    return path.relative(root, abs).replace(/\\/g, '/');
  };

  const attach = (dir: string, recursive: boolean, listener: (event: string, f: string | null) => void): void => {
    const w = watchFn(dir, { recursive }, listener);
    w.on('error', reportError);
    watchers.set(dir, w);
  };

  let degraded = false;
  const markDegraded = (): void => {
    if (degraded) return;
    degraded = true;
    try {
      opts.onDegraded?.();
    } catch (err) {
      reportError(err);
    }
  };

  const watchDir = (dir: string): void => {
    if (closed || watchers.has(dir)) return;
    if (watchers.size >= maxDirs) {
      markDegraded();
      return;
    }
    try {
      attach(dir, false, (_event, filename) => {
        if (closed || filename === null) return;
        const abs = path.join(dir, filename.toString());
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        accept(rel);
        if (rel !== '' && !ignored(rel, true)) walkIfDir(abs);
      });
    } catch (err) {
      reportError(err);
    }
  };

  const walkIfDir = (abs: string): void => {
    if (degraded || closed) return;
    try {
      if (!fs.statSync(abs).isDirectory()) return;
    } catch {
      return;
    }
    watchDir(abs);
    if (degraded) return;
    let entries: fs.Dirent[];
    try {
      entries = readdir(abs);
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(abs, e.name);
      if (ignored(path.relative(root, child).replace(/\\/g, '/'), true)) continue;
      walkIfDir(child);
    }
  };

  try {
    attach(root, true, (_event, filename) => {
      if (closed || filename === null) return;
      accept(toRel(root, filename.toString()));
    });
  } catch {
    walkIfDir(root);
    if (watchers.size === 0) {
      reportError(new Error(`Could not watch ${root}`));
      markDegraded();
    }
  }

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      pending = new Set();
      for (const w of watchers.values()) {
        try {
          w.close();
        } catch {
          // already closed
        }
      }
      watchers.clear();
    },
  };
}
