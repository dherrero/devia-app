/**
 * REV-AGENT-CORE-009: tests for the Windows command-line budget guards.
 *
 * The two outer functions (`checkWindowsCmdShimCommandLineBudget` and
 * `checkWindowsDirectExeCommandLineBudget`) are gated on
 * `process.platform === 'win32'`, so we test them only when running on
 * Windows. The pure quoting helpers and the length check are tested
 * unconditionally on every host.
 */
import { describe, it, expect } from 'vitest';
import {
  quoteWindowsExeArg,
  composeWindowsExeCommandLine,
  composeWindowsCmdShimCommandLine,
  checkWindowsCmdShimCommandLineBudget,
  checkWindowsDirectExeCommandLineBudget,
  __test,
} from './prompt-budget';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';

const fakeDef: RuntimeAgentDef = {
  id: 'fake',
  name: 'Fake CLI',
  bin: 'fake',
  versionArgs: ['--version'],
  fallbackModels: [],
  buildArgs: () => [],
  streamFormat: 'plain',
  systemPromptStrategy: 'unsupported',
  maxPromptArgBytes: 1_000_000, // enable argv guards
};

describe('quoteWindowsExeArg (libuv quote_cmd_arg)', () => {
  it('passes simple args through unchanged', () => {
    expect(quoteWindowsExeArg('foo')).toBe('foo');
    expect(quoteWindowsExeArg('a/b/c')).toBe('a/b/c');
  });

  it('wraps args containing spaces in quotes', () => {
    expect(quoteWindowsExeArg('hello world')).toBe('"hello world"');
  });

  it('escapes embedded quotes with a leading backslash', () => {
    expect(quoteWindowsExeArg('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('doubles trailing backslashes that precede the closing quote (when wrapping is needed)', () => {
    // `arg \` (has whitespace → triggers wrapping) → `"arg \\"` (trailing `\` doubled before close).
    expect(quoteWindowsExeArg('arg \\')).toBe('"arg \\\\"');
  });

  it('passes simple backslash args through unchanged when no whitespace or quotes', () => {
    // `arg\` alone has no whitespace/quote → fast path returns it verbatim.
    expect(quoteWindowsExeArg('arg\\')).toBe('arg\\');
  });

  it('quotes the empty string', () => {
    expect(quoteWindowsExeArg('')).toBe('""');
  });

  it('quotes whitespace-only args', () => {
    expect(quoteWindowsExeArg('   ')).toBe('"   "');
  });
});

describe('composeWindowsExeCommandLine', () => {
  it('joins binary + args with spaces; each part quoted by libuv rules', () => {
    expect(composeWindowsExeCommandLine('C:\\bin\\fake.exe', ['hello', 'with space']))
      .toBe('C:\\bin\\fake.exe hello "with space"');
  });

  it('handles paths with spaces in the binary itself', () => {
    expect(composeWindowsExeCommandLine('C:\\Program Files\\foo.exe', ['arg']))
      .toBe('"C:\\Program Files\\foo.exe" arg');
  });
});

describe('composeWindowsCmdShimCommandLine', () => {
  it('wraps everything in cmd.exe /d /s /c "<inner>"', () => {
    const line = composeWindowsCmdShimCommandLine('C:\\bin\\foo.cmd', ['arg']);
    expect(line.startsWith('cmd.exe /d /s /c "')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
  });

  it('doubles every quote inside the inner string', () => {
    const line = composeWindowsCmdShimCommandLine('foo.cmd', ['"hello"']);
    // The inner string after libuv quoting is `foo.cmd "\"hello\""` (4 `"` chars).
    // cmd.exe quote-doubling turns every `"` into `""`, so the final string
    // must contain twice as many quote characters as the libuv-quoted inner.
    const libuvInner = 'foo.cmd "\\"hello\\""';
    const innerQuoteCount = (libuvInner.match(/"/g) ?? []).length;
    const outerQuoteCount = (line.match(/"/g) ?? []).length;
    // The outer cmd.exe wrap adds 2 quotes around the (escaped) inner;
    // so the final count = innerQuoteCount * 2 + 2.
    expect(outerQuoteCount).toBe(innerQuoteCount * 2 + 2);
  });

  it('neutralises percent signs to avoid env-var expansion', () => {
    const line = composeWindowsCmdShimCommandLine('foo.cmd', ['hello%']);
    // `%` becomes `"^%"` in cmd.exe — and the surrounding `"` then get doubled.
    expect(line).toContain('"^%"');
  });
});

describe('isCmdShim / isWindowsExe helpers', () => {
  it('detects cmd shims by extension', () => {
    expect(__test.isCmdShim('C:\\bin\\foo.cmd')).toBe(true);
    expect(__test.isCmdShim('C:\\bin\\foo.bat')).toBe(true);
    expect(__test.isCmdShim('C:\\bin\\foo.CMD')).toBe(true);
    expect(__test.isCmdShim('C:\\bin\\foo.exe')).toBe(false);
    expect(__test.isCmdShim('/usr/bin/foo')).toBe(false);
  });

  it('detects Windows exe paths by extension or drive letter', () => {
    expect(__test.isWindowsExe('C:\\bin\\foo.exe')).toBe(true);
    expect(__test.isWindowsExe('D:/foo/bar')).toBe(true);
    expect(__test.isWindowsExe('/usr/bin/foo')).toBe(false);
    expect(__test.isWindowsExe('foo.exe')).toBe(true);
  });
});

describe('Windows budget guards on non-Windows hosts', () => {
  const isWin = process.platform === 'win32';

  it.skipIf(isWin)('checkWindowsCmdShimCommandLineBudget returns null on POSIX', () => {
    const r = checkWindowsCmdShimCommandLineBudget(fakeDef, 'C:\\bin\\foo.cmd', ['x'.repeat(50_000)]);
    expect(r).toBeNull();
  });

  it.skipIf(isWin)('checkWindowsDirectExeCommandLineBudget returns null on POSIX', () => {
    const r = checkWindowsDirectExeCommandLineBudget(fakeDef, 'C:\\bin\\foo.exe', ['x'.repeat(50_000)]);
    expect(r).toBeNull();
  });
});

describe('Windows budget guards on Windows hosts', () => {
  const isWin = process.platform === 'win32';

  it.runIf(isWin)('flags oversize .cmd shim command lines', () => {
    const r = checkWindowsCmdShimCommandLineBudget(fakeDef, 'C:\\bin\\foo.cmd', ['x'.repeat(50_000)]);
    expect(r?.code).toBe('AGENT_PROMPT_TOO_LARGE');
    expect(r?.commandLineLength).toBeGreaterThan(32_000);
  });

  it.runIf(isWin)('flags oversize .exe command lines', () => {
    const r = checkWindowsDirectExeCommandLineBudget(fakeDef, 'C:\\bin\\foo.exe', ['x'.repeat(50_000)]);
    expect(r?.code).toBe('AGENT_PROMPT_TOO_LARGE');
  });

  it.runIf(isWin)('returns null for small command lines on .exe', () => {
    const r = checkWindowsDirectExeCommandLineBudget(fakeDef, 'C:\\bin\\foo.exe', ['small']);
    expect(r).toBeNull();
  });
});
