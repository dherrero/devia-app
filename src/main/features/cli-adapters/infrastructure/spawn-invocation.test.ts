/**
 * Unit tests for the cross-platform `createCommandInvocation` helper.
 *
 * Coverage matrix:
 *   - POSIX (Darwin + Linux): identity transform, never sets
 *     `windowsVerbatimArguments`. This is the property that keeps Mac
 *     and Linux behaviour identical to the pre-helper code.
 *   - Windows + `.exe`: identity transform (Node spawn handles `.exe`
 *     directly on Windows).
 *   - Windows + `.cmd` / `.bat`: wrapped in
 *     `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments: true`.
 *   - Quoting: spaces, percent signs, embedded `"`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  createCommandInvocation,
  quoteWindowsCommandArg,
} from './spawn-invocation';

function platformDescriptor(): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) throw new Error('process.platform descriptor not found');
  return descriptor;
}

const origPlatform = platformDescriptor();

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', origPlatform);
});

describe('createCommandInvocation — POSIX', () => {
  it('returns identity on linux', () => {
    setPlatform('linux');
    const r = createCommandInvocation({ command: '/usr/local/bin/codex', args: ['--version'] });
    expect(r.command).toBe('/usr/local/bin/codex');
    expect(r.args).toEqual(['--version']);
    expect(r.windowsVerbatimArguments).toBe(false);
  });

  it('returns identity on darwin', () => {
    setPlatform('darwin');
    const r = createCommandInvocation({ command: '/opt/homebrew/bin/opencode', args: ['models'] });
    expect(r.command).toBe('/opt/homebrew/bin/opencode');
    expect(r.args).toEqual(['models']);
    expect(r.windowsVerbatimArguments).toBe(false);
  });

  it('returns identity even when the path ends in .cmd on POSIX (no Windows wrap)', () => {
    setPlatform('linux');
    const r = createCommandInvocation({ command: '/tmp/weird-name.cmd', args: ['x'] });
    expect(r.command).toBe('/tmp/weird-name.cmd');
    expect(r.windowsVerbatimArguments).toBe(false);
  });

  it('clones the args array (caller mutation safety)', () => {
    setPlatform('linux');
    const input = ['--version'];
    const r = createCommandInvocation({ command: 'claude', args: input });
    input.push('--polluted');
    expect(r.args).toEqual(['--version']);
  });
});

describe('createCommandInvocation — Windows .exe', () => {
  it('returns identity for .exe targets', () => {
    setPlatform('win32');
    const r = createCommandInvocation({
      command: 'C:\\Users\\test\\AppData\\Local\\codex\\codex.exe',
      args: ['--version'],
    });
    expect(r.command).toBe('C:\\Users\\test\\AppData\\Local\\codex\\codex.exe');
    expect(r.args).toEqual(['--version']);
    expect(r.windowsVerbatimArguments).toBe(false);
  });

  it('returns identity for bare names without an extension', () => {
    setPlatform('win32');
    const r = createCommandInvocation({ command: 'codex', args: [] });
    expect(r.command).toBe('codex');
    expect(r.windowsVerbatimArguments).toBe(false);
  });
});

describe('createCommandInvocation — Windows .cmd / .bat', () => {
  it('wraps a .cmd shim in cmd.exe /d /s /c', () => {
    setPlatform('win32');
    const r = createCommandInvocation({
      command: 'C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['--version'],
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(r.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(r.args[0]).toBe('/d');
    expect(r.args[1]).toBe('/s');
    expect(r.args[2]).toBe('/c');
    expect(r.windowsVerbatimArguments).toBe(true);
    // The shim path contains no spaces here, so it should appear unquoted.
    expect(r.args[3]).toBe('"codex.cmd --version"'.replace('codex.cmd', 'C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd'));
  });

  it('wraps a .bat shim with the same shape', () => {
    setPlatform('win32');
    const r = createCommandInvocation({
      command: 'C:\\path\\foo.bat',
      args: ['arg'],
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(r.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(r.windowsVerbatimArguments).toBe(true);
  });

  it('quotes a shim path that contains spaces', () => {
    setPlatform('win32');
    const r = createCommandInvocation({
      command: 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['--version'],
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(r.args[3]).toContain('"C:\\Users\\First Last\\AppData\\Roaming\\npm\\codex.cmd"');
  });

  it('falls back to "cmd.exe" when ComSpec is not set', () => {
    setPlatform('win32');
    const prev = process.env['ComSpec'];
    delete process.env['ComSpec'];
    try {
      const r = createCommandInvocation({ command: 'foo.cmd', args: [], env: {} });
      expect(r.command).toBe('cmd.exe');
    } finally {
      if (prev) process.env['ComSpec'] = prev;
    }
  });
});

describe('quoteWindowsCommandArg', () => {
  it('leaves a simple identifier unquoted', () => {
    expect(quoteWindowsCommandArg('--version')).toBe('--version');
    expect(quoteWindowsCommandArg('hello')).toBe('hello');
  });

  it('quotes args with spaces', () => {
    expect(quoteWindowsCommandArg('with space')).toBe('"with space"');
  });

  it('doubles embedded double-quotes', () => {
    expect(quoteWindowsCommandArg('say "hi"')).toBe('"say ""hi"""');
  });

  it('breaks percent-expansion via the "^%" toggle trick', () => {
    // `%FOO%` would otherwise expand to a live env var inside cmd.exe's
    // /s /c parsing. The escape produces a literal `%` byte in the child.
    expect(quoteWindowsCommandArg('%FOO%')).toBe('"' + '"^%"FOO"^%"' + '"');
  });

  it('quotes args containing shell-meta characters', () => {
    expect(quoteWindowsCommandArg('a&b')).toBe('"a&b"');
    expect(quoteWindowsCommandArg('a|b')).toBe('"a|b"');
  });

  // UC-FIX-004: document that < > ^ are safe inside the outer quotes.
  // cmd.exe stops interpreting these as operators inside a quoted segment;
  // no extra per-char escaping is required beyond the outer wrapper.
  it('AC1: quotes args containing < and > (redirection operators)', () => {
    expect(quoteWindowsCommandArg('a<b')).toBe('"a<b"');
    expect(quoteWindowsCommandArg('a>b')).toBe('"a>b"');
  });

  it('quotes args containing ^ (escape character — literal inside quotes)', () => {
    expect(quoteWindowsCommandArg('a^b')).toBe('"a^b"');
  });

  it('AC2: percent signs are broken via the "^%" toggle', () => {
    // A plain %PATH% would expand to a live env value via cmd.exe
    // percent-expansion. The toggle produces the literal string.
    expect(quoteWindowsCommandArg('%PATH%')).toBe('"' + '"^%"PATH"^%"' + '"');
  });

  it('AC3: embedded double-quote is doubled inside the outer wrapper', () => {
    // The child receives the literal string: say "hi"
    expect(quoteWindowsCommandArg('say "hi"')).toBe('"say ""hi"""');
  });

  it('multiple meta-chars in one arg — & | < > ^ % all neutralised', () => {
    const result = quoteWindowsCommandArg('a&b|c<d>e^f');
    // All meta-chars trigger quoting; none need per-char escaping (no " or %).
    expect(result).toBe('"a&b|c<d>e^f"');
  });

  it('combined: spaces + percent in a realistic path arg', () => {
    const arg = 'C:\\Users\\%USERNAME%\\AppData\\Local';
    const result = quoteWindowsCommandArg(arg);
    // Contains space AND %, so quoting + percent-toggle are both applied.
    expect(result).toContain('"^%"USERNAME"^%"');
    expect(result.startsWith('"')).toBe(true);
  });
});
