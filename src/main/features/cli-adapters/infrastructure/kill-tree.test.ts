import { describe, it, expect, vi } from 'vitest';
import { killProcessTree } from './kill-tree';
import type { ExecFileFn } from './kill-tree';

describe('killProcessTree', () => {
  // ── Windows + cmd shell wrap ─────────────────────────────────────────────

  it('AC1 Windows + usedCmdShell: invokes taskkill with /T /F /PID <pid>', () => {
    const execFileFn: ExecFileFn = vi.fn((_cmd, _args, cb) => cb(null));
    const fallback = vi.fn();

    killProcessTree(1234, true, fallback, { platform: 'win32', execFileFn });

    expect(execFileFn).toHaveBeenCalledOnce();
    expect(execFileFn).toHaveBeenCalledWith(
      'taskkill',
      ['/T', '/F', '/PID', '1234'],
      expect.any(Function),
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it('AC1 Windows + usedCmdShell: fallback NOT called when taskkill succeeds', () => {
    const execFileFn: ExecFileFn = vi.fn((_cmd, _args, cb) => cb(null));
    const fallback = vi.fn();

    killProcessTree(99, true, fallback, { platform: 'win32', execFileFn });

    expect(fallback).not.toHaveBeenCalled();
  });

  it('AC3 Windows + usedCmdShell + taskkill fails: logs warning and calls fallback', () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const execFileFn: ExecFileFn = vi.fn((_cmd, _args, cb) =>
      cb(new Error('taskkill: not found')),
    );
    const fallback = vi.fn();

    killProcessTree(42, true, fallback, { platform: 'win32', execFileFn });

    expect(fallback).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('taskkill failed'),
      expect.stringContaining('taskkill: not found'),
    );
    warnSpy.mockRestore();
  });

  it('Windows + usedCmdShell + pid undefined: falls back (no taskkill call)', () => {
    const execFileFn: ExecFileFn = vi.fn();
    const fallback = vi.fn();

    killProcessTree(undefined, true, fallback, { platform: 'win32', execFileFn });

    expect(execFileFn).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  // ── POSIX / non-shell paths ──────────────────────────────────────────────

  it('AC2 POSIX path: fallback called, taskkill never invoked', () => {
    const execFileFn: ExecFileFn = vi.fn();
    const fallback = vi.fn();

    killProcessTree(5678, false, fallback, { platform: 'linux', execFileFn });

    expect(execFileFn).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('Windows + usedCmdShell=false: fallback called, no taskkill', () => {
    const execFileFn: ExecFileFn = vi.fn();
    const fallback = vi.fn();

    killProcessTree(100, false, fallback, { platform: 'win32', execFileFn });

    expect(execFileFn).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('macOS path: fallback called, no taskkill', () => {
    const execFileFn: ExecFileFn = vi.fn();
    const fallback = vi.fn();

    killProcessTree(9, false, fallback, { platform: 'darwin', execFileFn });

    expect(execFileFn).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });
});
