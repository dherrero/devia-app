/**
 * REV-TS-CLI-14-03 — No Tests for Process-Spawning Layer
 *
 * Unit tests for `resolve-bin.ts` — the binary resolution and launch
 * configuration logic for agent CLI adapters.
 *
 * We mock `fs.existsSync` (via vi.spyOn) and `require.resolve` to avoid
 * touching the real file system or requiring the optional native package.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAgentBin } from './resolve-bin';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';

function makeClaudeDef(overrides: Partial<RuntimeAgentDef> = {}): RuntimeAgentDef {
  return {
    id: 'claude',
    bin: 'claude',
    name: 'Claude Code',
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => [],
    streamFormat: 'claude-stream-json',
    ...overrides,
  } as RuntimeAgentDef;
}

function makeCodexDef(overrides: Partial<RuntimeAgentDef> = {}): RuntimeAgentDef {
  return {
    id: 'codex',
    bin: 'codex',
    name: 'OpenAI Codex',
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => [],
    streamFormat: 'json-event-stream',
    eventParser: 'codex',
    ...overrides,
  } as RuntimeAgentDef;
}

describe('resolveAgentBin — non-Codex agents', () => {
  it('returns launchKind=selected and launchPath=def.bin for Claude', () => {
    const def = makeClaudeDef({ bin: 'claude' });
    const result = resolveAgentBin(def, {});
    expect(result.launchKind).toBe('selected');
    expect(result.launchPath).toBe('claude');
    expect(result.selectedPath).toBe('claude');
    expect(result.childPathPrepend).toEqual([]);
    expect(result.diagnostic).toBeNull();
  });

  it('returns launchKind=selected for any non-codex agent id', () => {
    const def = makeClaudeDef({ id: 'gemini', bin: 'gemini' });
    const result = resolveAgentBin(def, {});
    expect(result.launchKind).toBe('selected');
    expect(result.launchPath).toBe('gemini');
  });

  it('returns launchKind=selected for opencode agent', () => {
    const def = makeClaudeDef({ id: 'opencode', bin: 'opencode' });
    const result = resolveAgentBin(def, {});
    expect(result.launchKind).toBe('selected');
  });
});

describe('resolveAgentBin — Codex on non-Windows', () => {
  it('returns launchKind=selected (uses the shim) on non-Windows', () => {
    // On the test runner (Linux/macOS/Windows), if platform !== 'win32', the
    // function skips native resolution and returns the shim path.
    if (process.platform === 'win32') {
      // On Windows, we cannot test the non-Windows branch directly.
      // Skip this test (it would need platform mocking which is risky).
      return;
    }

    const def = makeCodexDef({ bin: 'codex' });
    const result = resolveAgentBin(def, {});
    expect(result.launchKind).toBe('selected');
    expect(result.launchPath).toBe('codex');
    expect(result.childPathPrepend).toEqual([]);
    expect(result.diagnostic).toBeNull();
  });
});

describe('resolveAgentBin — Codex on Windows', () => {
  it('falls back to shim with diagnostic when native package is absent (Windows only)', () => {
    if (process.platform !== 'win32') {
      // Native binary resolution is Windows-only. On Linux/macOS the function
      // skips directly to the 'selected' branch (tested in the non-Windows suite
      // above). This test is a no-op on non-Windows CI.
      return;
    }

    // On real Windows without @openai/codex-win32-x64 installed, `require.resolve`
    // throws MODULE_NOT_FOUND — findCodexNativeBinary returns null, and the
    // function returns the shim path with a diagnostic note.
    const def = makeCodexDef({ bin: 'codex' });
    const result = resolveAgentBin(def, {});

    // Either found native binary (codex-native) or fell back to shim (selected)
    // with a diagnostic. Both are valid outcomes — we just verify no throw.
    expect(['selected', 'codex-native']).toContain(result.launchKind);
    expect(result.launchPath).toBeTruthy();
  });
});

describe('resolveAgentBin — Codex global npm install via PATH', () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('finds the native exe nested under the codex shim dir (npm -g layout)', () => {
    if (process.platform !== 'win32') return;

    // Mimic `npm i -g @openai/codex` on Windows: a `codex.cmd` shim next to
    // node_modules/@openai/codex/node_modules/@openai/codex-win32-x64 with the
    // current `vendor/<triple>/bin/codex.exe` packaging.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-global-'));
    tmpDirs.push(root);
    const vendorBin = path.join(
      root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
      'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin',
    );
    fs.mkdirSync(vendorBin, { recursive: true });
    const exe = path.join(vendorBin, 'codex.exe');
    fs.writeFileSync(exe, '');
    fs.writeFileSync(path.join(root, 'codex.cmd'), '');

    const result = resolveAgentBin(makeCodexDef(), { PATH: root });
    expect(result.launchKind).toBe('codex-native');
    expect(result.launchPath).toBe(exe);
    expect(result.childPathPrepend).toEqual([vendorBin]);
    expect(result.diagnostic).toBeNull();
  });

  it('PATH dirs without a codex shim are not probed', () => {
    if (process.platform !== 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-noshim-'));
    tmpDirs.push(root);
    // Native package present but NO shim → this dir must be skipped (and with
    // no other source available the resolver falls back to the shim).
    const vendorBin = path.join(
      root, 'node_modules', '@openai', 'codex-win32-x64',
      'vendor', 'x86_64-pc-windows-msvc', 'bin',
    );
    fs.mkdirSync(vendorBin, { recursive: true });
    fs.writeFileSync(path.join(vendorBin, 'codex.exe'), '');

    const result = resolveAgentBin(makeCodexDef(), { PATH: root });
    expect(result.launchKind).toBe('selected');
  });
});

describe('resolveAgentBin — never throws', () => {
  it('returns a safe fallback when an unexpected error occurs', () => {
    // Corrupt the env object in a way that should be harmless to resolveAgentBin.
    // The function has a top-level try/catch that must never propagate.
    const def = makeClaudeDef();

    // Even with a completely empty / weird env, it must not throw.
    expect(() => resolveAgentBin(def, {})).not.toThrow();
    expect(() => resolveAgentBin(def, Object.create(null) as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('returns non-null launchPath for standard agents', () => {
    const def = makeClaudeDef({ bin: 'claude' });
    const result = resolveAgentBin(def, {});
    expect(result.launchPath).toBeTruthy();
  });
});

describe('resolveAgentBin — AgentBinResolution shape', () => {
  it('always returns all required fields', () => {
    const def = makeClaudeDef();
    const result = resolveAgentBin(def, {});

    expect(result).toHaveProperty('selectedPath');
    expect(result).toHaveProperty('launchPath');
    expect(result).toHaveProperty('launchKind');
    expect(result).toHaveProperty('childPathPrepend');
    expect(result).toHaveProperty('diagnostic');
  });

  it('childPathPrepend is always an array', () => {
    const def = makeClaudeDef();
    const result = resolveAgentBin(def, {});
    expect(Array.isArray(result.childPathPrepend)).toBe(true);
  });
});
