import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileWatcher, type WatchFn, type WatcherHandle } from './file-watcher';

type Listener = (event: string, filename: string | null) => void;

interface FakeWatch {
  watchFn: WatchFn;
  emit(filename: string | null, dir?: string): void;
  closed: number;
  errorHandlers: Array<(e: Error) => void>;
  calls: Array<{ dir: string; recursive: boolean }>;
}

function fakeWatch(failRecursive = false): FakeWatch {
  const listeners = new Map<string, Listener>();
  const fake: FakeWatch = {
    closed: 0,
    errorHandlers: [],
    calls: [],
    watchFn: (dir, opts, listener) => {
      fake.calls.push({ dir, recursive: opts.recursive });
      if (failRecursive && opts.recursive) {
        throw Object.assign(new Error('unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
      }
      listeners.set(dir, listener);
      return {
        close: () => {
          fake.closed++;
        },
        on: (_event: 'error', cb: (e: Error) => void) => {
          fake.errorHandlers.push(cb);
        },
      };
    },
    emit: (filename, dir) => {
      const l = dir !== undefined ? listeners.get(dir) : [...listeners.values()][0];
      l?.('change', filename);
    },
  };
  return fake;
}

const root = path.join(os.tmpdir(), 'cg-fw-root');
const tsOnly = (rel: string): boolean => rel.endsWith('.ts');

beforeEach(() => {
  // The watcher checks that its root still exists on top-level events.
  fs.mkdirSync(root, { recursive: true });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('createFileWatcher (fake watchFn)', () => {
  it('delivers three writes inside the window as ONE callback', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    const w = createFileWatcher(root, tsOnly, onChange, { watchFn: fake.watchFn });
    fake.emit('a.ts');
    fake.emit('src\\b.ts');
    vi.advanceTimersByTime(300);
    fake.emit('c.ts');
    fake.emit('a.ts');
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['a.ts', 'src/b.ts', 'c.ts'], false);
    w.close();
  });

  it('ignores node_modules, .git and irrelevant extensions', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    const w = createFileWatcher(root, tsOnly, onChange, { watchFn: fake.watchFn });
    fake.emit('node_modules/x/index.ts');
    fake.emit('.git/HEAD.ts');
    fake.emit('readme.md');
    fake.emit(null);
    vi.advanceTimersByTime(2000);
    expect(onChange).not.toHaveBeenCalled();
    w.close();
  });

  it('reports overflow beyond 5000 paths', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    const w = createFileWatcher(root, tsOnly, onChange, { watchFn: fake.watchFn });
    for (let i = 0; i < 5001; i++) fake.emit(`f${i}.ts`);
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([], true);
    w.close();
  });

  it('close is idempotent, clears the timer and stops events', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    const w = createFileWatcher(root, tsOnly, onChange, { watchFn: fake.watchFn });
    fake.emit('a.ts');
    w.close();
    w.close();
    expect(fake.closed).toBe(1);
    fake.emit('b.ts');
    vi.advanceTimersByTime(2000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('routes watcher errors to onError', () => {
    const fake = fakeWatch();
    const onError = vi.fn();
    const w = createFileWatcher(root, tsOnly, vi.fn(), { watchFn: fake.watchFn, onError });
    const err = new Error('boom');
    fake.errorHandlers[0]?.(err);
    expect(onError).toHaveBeenCalledWith(err);
    w.close();
  });

  it('routes callback exceptions to onError instead of throwing', () => {
    const fake = fakeWatch();
    const onError = vi.fn();
    const w = createFileWatcher(
      root,
      tsOnly,
      () => {
        throw new Error('cb');
      },
      { watchFn: fake.watchFn, onError },
    );
    fake.emit('a.ts');
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    w.close();
  });

  it('reports a total watch failure through onError', () => {
    const onError = vi.fn();
    const w = createFileWatcher(root, tsOnly, vi.fn(), {
      watchFn: () => {
        throw new Error('nope');
      },
      onError,
    });
    expect(onError).toHaveBeenCalled();
    expect(() => w.close()).not.toThrow();
  });
});

describe('createFileWatcher fallback', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fw-fb-'));
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to one watcher per non-ignored directory', () => {
    const fake = fakeWatch(true);
    const onChange = vi.fn();
    const onDegraded = vi.fn();
    const w = createFileWatcher(dir, tsOnly, onChange, { watchFn: fake.watchFn, onDegraded });
    const dirs = fake.calls.filter((c) => !c.recursive).map((c) => path.relative(dir, c.dir));
    expect(dirs.sort()).toEqual(['', path.join('src'), path.join('src', 'deep')].sort());
    expect(onDegraded).not.toHaveBeenCalled();
    fake.emit('x.ts', path.join(dir, 'src', 'deep'));
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledWith(['src/deep/x.ts'], false);
    w.close();
    expect(fake.closed).toBe(3);
  });

  it('watches directories created later', () => {
    const fake = fakeWatch(true);
    const w = createFileWatcher(dir, tsOnly, vi.fn(), { watchFn: fake.watchFn });
    fs.mkdirSync(path.join(dir, 'newdir'));
    fake.emit('newdir', dir);
    expect(fake.calls.some((c) => c.dir === path.join(dir, 'newdir'))).toBe(true);
    w.close();
  });

  it('reports degraded when the directory cap is exceeded', () => {
    const fake = fakeWatch(true);
    const onDegraded = vi.fn();
    const w = createFileWatcher(dir, tsOnly, vi.fn(), { watchFn: fake.watchFn, onDegraded, maxDirs: 2 });
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(fake.calls.filter((c) => !c.recursive)).toHaveLength(2);
    w.close();
  });
});

describe('createFileWatcher degraded walk', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fw-deg-'));
    fs.mkdirSync(path.join(dir, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stops walking once the directory cap is reached', () => {
    const fake = fakeWatch(true);
    const readdir = vi.fn((d: string) => fs.readdirSync(d, { withFileTypes: true }));
    const onDegraded = vi.fn();
    const w = createFileWatcher(dir, tsOnly, vi.fn(), {
      watchFn: fake.watchFn,
      readdirFn: readdir,
      maxDirs: 2,
      onDegraded,
    });
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(readdir.mock.calls.length).toBeLessThanOrEqual(2);
    w.close();
  });

  it('reports degraded when every per-directory attach fails', () => {
    const onDegraded = vi.fn();
    const onError = vi.fn();
    const w = createFileWatcher(dir, tsOnly, vi.fn(), {
      watchFn: () => {
        throw new Error('ENOSPC');
      },
      onDegraded,
      onError,
    });
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
    w.close();
  });
});

describe('createFileWatcher out of watch handles and deleted root', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fw-nospc-'));
    fs.mkdirSync(path.join(dir, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'x', 'y'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stops the per-directory fallback at the first ENOSPC instead of failing on every directory', () => {
    const calls: string[] = [];
    const readdir = vi.fn((d: string) => fs.readdirSync(d, { withFileTypes: true }));
    const onError = vi.fn();
    const onDegraded = vi.fn();
    const w = createFileWatcher(dir, tsOnly, vi.fn(), {
      watchFn: (d) => {
        calls.push(d);
        throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
      },
      readdirFn: readdir,
      onError,
      onDegraded,
    });
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(readdir).not.toHaveBeenCalled();
    w.close();
  });

  it('keeps the directories already watched when ENOSPC hits midway, and reports degraded', () => {
    let attached = 0;
    const onDegraded = vi.fn();
    const fake = fakeWatch(true);
    const w = createFileWatcher(dir, tsOnly, vi.fn(), {
      watchFn: (d, o, l) => {
        if (!o.recursive && ++attached > 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        return fake.watchFn(d, o, l);
      },
      onDegraded,
      onError: () => undefined,
    });
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(fake.calls.filter((c) => !c.recursive)).toHaveLength(2);
    expect(attached).toBe(3);
    w.close();
    expect(fake.closed).toBe(2);
  });

  it('reports a deleted root once, closes its watchers and ignores later events', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    const onError = vi.fn();
    const onDegraded = vi.fn();
    const w = createFileWatcher(dir, tsOnly, onChange, { watchFn: fake.watchFn, onError, onDegraded });
    fake.emit('a.ts');
    fs.rmSync(dir, { recursive: true, force: true });
    fake.emit(path.basename(dir));
    fake.emit('b.ts');
    vi.advanceTimersByTime(1000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'WATCH_ROOT_GONE' });
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(fake.closed).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['a.ts'], false);
    w.close();
    expect(fake.closed).toBe(1);
  });
});

describe('createFileWatcher (real fs)', () => {
  let dir: string;
  let handle: WatcherHandle | undefined;
  beforeEach(() => {
    vi.useRealTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fw-real-'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
  });
  afterEach(() => {
    handle?.close();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Verified on macOS (FSEvents reports a change of the root's own name). Linux and Windows report
  // a deleted watched root differently (or refuse to delete it); the fake tests above cover the logic.
  it.skipIf(process.platform !== 'darwin')('reports the project folder being deleted', async () => {
    const errors: unknown[] = [];
    let degraded = false;
    handle = createFileWatcher(dir, tsOnly, () => undefined, {
      onError: (e) => errors.push(e),
      onDegraded: () => (degraded = true),
    });
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(dir, { recursive: true, force: true });
    const deadline = Date.now() + 10_000;
    while (!degraded && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(degraded).toBe(true);
    expect(errors).toEqual([expect.objectContaining({ code: 'WATCH_ROOT_GONE' })]);
  }, 15_000);

  it('batches three quick writes into one callback and ignores node_modules', async () => {
    const batches: string[][] = [];
    handle = createFileWatcher(dir, tsOnly, (paths) => batches.push(paths), { debounceMs: 1000 });
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(dir, 'a.ts'), '1');
    fs.writeFileSync(path.join(dir, 'b.ts'), '2');
    fs.writeFileSync(path.join(dir, 'c.ts'), '3');
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.ts'), '4');
    const deadline = Date.now() + 5000;
    while (batches.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 1500));
    expect([...new Set(batches.flat())].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});
