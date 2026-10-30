/**
 * REV-AGENT-CORE-014: PATH resolver Windows coverage.
 *
 * Electron on Windows often inherits a PATH that is missing the user's
 * npm-global / pnpm / scoop / WinGet directories, which is the root
 * cause behind "only Claude detected" reports. These tests verify the
 * resolver adds those directories from documented Windows environment
 * variables — never from hardcoded user-machine paths.
 *
 * Strategy: we cannot reliably `vi.spyOn` the `node:fs` namespace under
 * Vitest's ESM mode, so we exercise the resolver in two ways:
 *   1. Inspect the dir list it builds (`debugListResolvedDirs`) for
 *      Windows env-derived locations — no filesystem dependency.
 *   2. Confirm there are no hardcoded user-specific absolute paths in
 *      the source.
 *   3. Use a real tmpdir to confirm `resolveOnPath` honours the dir
 *      list end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearPathResolverCache,
  debugListResolvedDirs,
  resolveOnPath,
} from './path-resolver';

function platformDescriptor(): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) throw new Error('process.platform descriptor not found');
  return descriptor;
}

describe('path-resolver — Windows env-derived locations', () => {
  const origPlatform = platformDescriptor();
  const origEnv = { ...process.env };

  beforeEach(() => {
    clearPathResolverCache();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', origPlatform);
    process.env = { ...origEnv };
    clearPathResolverCache();
  });

  it('includes %APPDATA%\\npm in the search list (npm global default on Windows)', () => {
    // Real existing dir works for both stat+isDirectory and our assertion.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-path-roaming-'));
    const npmDir = path.join(root, 'npm');
    fs.mkdirSync(npmDir);
    process.env['APPDATA'] = root;
    process.env['LOCALAPPDATA'] = root; // satisfy other branches
    process.env['PROGRAMDATA'] = root;

    try {
      const dirs = debugListResolvedDirs();
      expect(dirs).toContain(npmDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes %LOCALAPPDATA%\\pnpm, Yarn\\bin, and WinGet links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-path-local-'));
    const pnpm = path.join(root, 'pnpm');
    const yarn = path.join(root, 'Yarn', 'bin');
    const winget = path.join(root, 'Microsoft', 'WinGet', 'Links');
    fs.mkdirSync(pnpm);
    fs.mkdirSync(yarn, { recursive: true });
    fs.mkdirSync(winget, { recursive: true });
    process.env['APPDATA'] = root;
    process.env['LOCALAPPDATA'] = root;
    process.env['PROGRAMDATA'] = root;

    try {
      const dirs = debugListResolvedDirs();
      expect(dirs).toContain(pnpm);
      expect(dirs).toContain(yarn);
      expect(dirs).toContain(winget);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes scoop shims under the home directory when present', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-path-home-'));
    const scoopShims = path.join(home, 'scoop', 'shims');
    fs.mkdirSync(scoopShims, { recursive: true });
    process.env['USERPROFILE'] = home;
    process.env['HOME'] = home;
    process.env['APPDATA'] = home;
    process.env['LOCALAPPDATA'] = home;
    process.env['PROGRAMDATA'] = home;

    try {
      const dirs = debugListResolvedDirs();
      expect(dirs).toContain(scoopShims);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolveOnPath finds a binary placed in %APPDATA%\\npm end-to-end', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-path-e2e-'));
    const npmDir = path.join(root, 'npm');
    fs.mkdirSync(npmDir);
    const fakeBin = path.join(npmDir, 'mycli.CMD');
    fs.writeFileSync(fakeBin, '@echo off');
    process.env['APPDATA'] = root;
    process.env['LOCALAPPDATA'] = root;
    process.env['PROGRAMDATA'] = root;
    process.env['PATHEXT'] = '.EXE;.CMD';
    process.env['PATH'] = '';

    try {
      const resolved = resolveOnPath('mycli');
      expect(resolved).toBe(fakeBin);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT hardcode any user-specific absolute path in source', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'path-resolver.ts'),
      'utf8',
    );
    // No literal "C:\\Users\\<name>" outside of comments — all Windows
    // dirs must be derived from documented env vars (process.env['APPDATA']
    // etc.).
    expect(source).not.toMatch(/['"][cC]:\\Users\\[A-Za-z]/);
    // Also no literal POSIX home path like /home/dani.
    expect(source).not.toMatch(/['"]\/home\/[a-z]/);
  });
});
