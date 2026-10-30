/**
 * REV-TS-CLI-13-02 — Unit tests for probeAgentAuthStatus / probeClaudeAuthStatus.
 *
 * Strategy: mock `node:child_process.execFile` so tests run without spawning
 * any real processes. Each test scenario drives the mock to simulate a specific
 * stdout/stderr combination and asserts the classification result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecFileException } from 'node:child_process';

// ── Hoisted mock setup ─────────────────────────────────────────────────────
// vi.mock is hoisted to the top by Vitest, so any factory variables must also
// be hoisted via vi.hoisted to avoid "cannot access before initialization" errors.

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

const { mockExecFile, getCapturedCallback, setCapturedCallback } = vi.hoisted(() => {
  let capturedCallback: ExecFileCallback | null = null;
  const mockExecFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      cb: ExecFileCallback,
    ) => {
      capturedCallback = cb;
      return { kill: vi.fn() };
    },
  );
  return {
    mockExecFile,
    getCapturedCallback: () => capturedCallback,
    setCapturedCallback: (cb: ExecFileCallback | null) => { capturedCallback = cb; },
  };
});

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

// Import after mock is registered.
import { probeAgentAuthStatus } from './auth-probe';
import { claudeAgentDef } from '../defs/claude';
import type { RuntimeAgentDef } from '../../domain/runtime-agent-def';

// REV-AGENT-CORE-010: the dispatcher now takes the agent def. We use the real
// Claude def (its `authProbe` is the function under test) and a minimal stub
// for non-Claude agents that simulates "no probe declared".
function fakeAgentDef(id: string): RuntimeAgentDef {
  return {
    id,
    name: id,
    bin: id,
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => [],
    streamFormat: 'plain',
    systemPromptStrategy: 'unsupported',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function resolveWith(stdout: string, stderr = ''): void {
  getCapturedCallback()?.(null, stdout, stderr);
}

function resolveWithError(code: string, message = 'spawn error'): void {
  const err = Object.assign(new Error(message), { code }) as ExecFileException;
  getCapturedCallback()?.(err, '', '');
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('probeAgentAuthStatus', () => {
  beforeEach(() => {
    setCapturedCallback(null);
    mockExecFile.mockClear();
  });

  // ── Non-claude agents ────────────────────────────────────────────────
  it('returns unknown immediately for agentId !== "claude" without spawning', async () => {
    const result = await probeAgentAuthStatus(fakeAgentDef('codex'), '/usr/bin/codex', {});
    expect(result).toEqual({ status: 'unknown' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns unknown for gemini without spawning', async () => {
    const result = await probeAgentAuthStatus(fakeAgentDef('gemini'), '/usr/bin/gemini', {});
    expect(result).toEqual({ status: 'unknown' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // ── "logged in" → ok ─────────────────────────────────────────────────
  it('returns ok when stdout contains "logged in"', async () => {
    const promise = probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {});
    resolveWith('Claude Code — logged in as alice@example.com');
    const result = await promise;
    expect(result).toEqual({ status: 'ok' });
  });

  it('returns ok when stdout contains "authenticated"', async () => {
    const promise = probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {});
    resolveWith('Status: authenticated');
    const result = await promise;
    expect(result).toEqual({ status: 'ok' });
  });

  it('is case-insensitive for ok check (uppercase "LOGGED IN")', async () => {
    const promise = probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {});
    resolveWith('LOGGED IN');
    const result = await promise;
    expect(result).toEqual({ status: 'ok' });
  });

  // ── "not logged in" → missing ─────────────────────────────────────────
  it('returns missing when stdout contains "not logged in"', async () => {
    const promise = probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {});
    resolveWith('Error: not logged in');
    const result = await promise;
    expect(result.status).toBe('missing');
    expect(result.message).toContain('claude login');
  });

  it('returns missing when stdout contains "login required"', async () => {
    const promise = probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {});
    resolveWith('login required to continue');
    const result = await promise;
    expect(result.status).toBe('missing');
  });

  it('returns missing when stdout contains "please log in"', async () => {
    const promise = probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {});
    resolveWith('please log in first');
    const result = await promise;
    expect(result.status).toBe('missing');
  });

  it('returns missing when stdout contains "not authenticated"', async () => {
    const promise = probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {});
    resolveWith('user not authenticated');
    const result = await promise;
    expect(result.status).toBe('missing');
  });

  it('"not logged in" takes priority over "logged in" substring check', async () => {
    // "not logged in" contains "logged in" as a substring — order must be correct
    const promise = probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {});
    resolveWith('not logged in');
    const result = await promise;
    expect(result.status).toBe('missing');
  });

  // ── Empty output → unknown ─────────────────────────────────────────────
  it('returns unknown when stdout and stderr are both empty', async () => {
    const promise = probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {});
    resolveWith('');
    const result = await promise;
    expect(result).toEqual({ status: 'unknown' });
  });

  it('returns unknown when output is unrecognised', async () => {
    const promise = probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {});
    resolveWith('some unrecognised output that matches nothing');
    const result = await promise;
    expect(result).toEqual({ status: 'unknown' });
  });

  // ── ENOENT → unknown ──────────────────────────────────────────────────
  it('returns unknown when execFile throws ENOENT (binary not found)', async () => {
    const promise = probeAgentAuthStatus(claudeAgentDef, '/nonexistent/claude', {});
    resolveWithError('ENOENT');
    const result = await promise;
    expect(result).toEqual({ status: 'unknown' });
  });

  // ── probeAgentAuthStatus outer try/catch ──────────────────────────────
  it('never throws even if probeClaudeAuthStatus throws internally', async () => {
    // Make execFile throw synchronously (extremely rare but documented edge case)
    mockExecFile.mockImplementationOnce(() => {
      throw new Error('unexpected sync throw from execFile');
    });
    await expect(
      probeAgentAuthStatus(claudeAgentDef, '/usr/bin/claude', {}),
    ).resolves.toEqual({ status: 'unknown' });
  });
});

