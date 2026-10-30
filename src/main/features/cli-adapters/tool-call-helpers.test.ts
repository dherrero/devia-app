/**
 * REV-TS-CLI-09-01 — No Unit Tests for ToolCallCardComponent
 *
 * Tests for the pure display-formatting helpers extracted from
 * `ToolCallCardComponent` computed signals into `shared/domain/tool-call.helpers.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  formatTerminalCommandForDisplay,
  formatToolInput,
  parseConsoleTableOutput,
  truncateResult,
  isRunningState,
  RESULT_TRUNCATE_LIMIT,
} from '../../../shared/domain/tool-call.helpers';

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('formatToolInput', () => {
  it('extracts command from Bash tool input', () => {
    const result = formatToolInput('Bash', { command: 'git status' });
    expect(result).toBe('git status');
  });

  it('extracts command from Execute tool input (Bash alias)', () => {
    const result = formatToolInput('Execute', { command: 'npm install' });
    expect(result).toBe('npm install');
  });

  it('shows a cleaned shell command for Bash tool input', () => {
    const result = formatToolInput('Bash', {
      command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'if (Test-Path AGENTS.md) { Get-Content AGENTS.md }\'',
    });
    expect(result).toBe('if (Test-Path AGENTS.md) { Get-Content AGENTS.md }');
  });

  it('falls back to JSON when Bash input has no command field', () => {
    const result = formatToolInput('Bash', { other: 'value' });
    expect(result).toBe(JSON.stringify({ other: 'value' }, null, 2));
  });

  it('extracts file_path from Edit tool input', () => {
    const result = formatToolInput('Edit', { file_path: '/foo/bar.ts', old_string: 'x', new_string: 'y' });
    expect(result).toBe('/foo/bar.ts');
  });

  it('extracts file_path from Write tool input', () => {
    const result = formatToolInput('Write', { file_path: '/src/main.ts', content: '...' });
    expect(result).toBe('/src/main.ts');
  });

  it('extracts file_path from MultiEdit tool input', () => {
    const result = formatToolInput('MultiEdit', { file_path: '/a/b.ts', edits: [] });
    expect(result).toBe('/a/b.ts');
  });

  it('extracts file_path from Read tool input', () => {
    const result = formatToolInput('Read', { file_path: '/src/index.ts' });
    expect(result).toBe('/src/index.ts');
  });

  it('falls back to path field when file_path is absent', () => {
    const result = formatToolInput('Read', { path: '/alt/path.ts' });
    expect(result).toBe('/alt/path.ts');
  });

  it('extracts question from AskUserQuestion tool input', () => {
    const result = formatToolInput('AskUserQuestion', { question: 'Should I proceed?' });
    expect(result).toBe('Should I proceed?');
  });

  it('extracts question from nested AskUserQuestion questions schema', () => {
    const result = formatToolInput('AskUserQuestion', {
      questions: [
        {
          header: 'Framework',
          question: '¿Qué framework de testing prefieres?',
          multiSelect: false,
          options: [{ label: 'Vitest' }, { label: 'Jest' }],
        },
      ],
    });
    expect(result).toBe('¿Qué framework de testing prefieres?');
  });

  it('returns JSON for unknown tool names', () => {
    const result = formatToolInput('Grep', { pattern: 'foo', path: '.' });
    expect(result).toBe(JSON.stringify({ pattern: 'foo', path: '.' }, null, 2));
  });

  it('returns null when input is null', () => {
    expect(formatToolInput('Bash', null)).toBeNull();
  });

  it('returns null when input is undefined', () => {
    expect(formatToolInput('Bash', undefined)).toBeNull();
  });
});

describe('formatTerminalCommandForDisplay', () => {
  it.each([
    [
      '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'if (Test-Path AGENTS.md) { Get-Content AGENTS.md }\'',
      'if (Test-Path AGENTS.md) { Get-Content AGENTS.md }',
    ],
    ['pwsh -Command "npm test"', 'npm test'],
    ['cmd.exe /c dir', 'dir'],
    ['bash -lc "npm test"', 'npm test'],
    ["sh -c 'ls -la'", 'ls -la'],
    ['git status', 'git status'],
  ])('cleans %s', (input, expected) => {
    expect(formatTerminalCommandForDisplay(input)).toBe(expected);
  });
});

describe('truncateResult', () => {
  it('returns the original string when within the limit', () => {
    const short = 'some output';
    expect(truncateResult(short)).toBe(short);
  });

  it('returns null when result is undefined', () => {
    expect(truncateResult(undefined)).toBeNull();
  });

  it('returns null when result is an empty string', () => {
    expect(truncateResult('')).toBeNull();
  });

  it('truncates strings longer than RESULT_TRUNCATE_LIMIT', () => {
    const longResult = 'x'.repeat(RESULT_TRUNCATE_LIMIT + 500);
    const truncated = expectPresent(truncateResult(longResult));
    expect(truncated.length).toBeLessThan(longResult.length);
    expect(truncated).toContain('[truncated]');
    expect(truncated.startsWith('x'.repeat(RESULT_TRUNCATE_LIMIT))).toBe(true);
  });

  it('accepts a custom limit', () => {
    const result = expectPresent(truncateResult('abcdefg', 3));
    expect(result).toContain('[truncated]');
    expect(result.startsWith('abc')).toBe(true);
  });

  it('does not truncate a string exactly at the limit', () => {
    const exact = 'y'.repeat(RESULT_TRUNCATE_LIMIT);
    expect(truncateResult(exact)).toBe(exact);
  });
});

describe('parseConsoleTableOutput', () => {
  it('parses PowerShell fixed-width table output', () => {
    const table = parseConsoleTableOutput(`
Name               Mode   Length
----               ----   ------
.angular           d-----
package-lock.json  -a---- 295222
AGENTS.md          -a---- 2793
`);

    expect(table).toEqual({
      headers: ['Name', 'Mode', 'Length'],
      rows: [
        ['.angular', 'd-----', ''],
        ['package-lock.json', '-a----', '295222'],
        ['AGENTS.md', '-a----', '2793'],
      ],
    });
  });

  it('returns null for ordinary command output', () => {
    expect(parseConsoleTableOutput('line one\nline two')).toBeNull();
  });
});

describe('isRunningState', () => {
  it('returns true when there is no result and no error flag', () => {
    expect(isRunningState(undefined, undefined)).toBe(true);
  });

  it('returns true when result is empty string and no error flag', () => {
    expect(isRunningState('', undefined)).toBe(true);
  });

  it('returns false when result is present', () => {
    expect(isRunningState('some output', undefined)).toBe(false);
  });

  it('returns false when isError is true (completed with error)', () => {
    expect(isRunningState(undefined, true)).toBe(false);
  });

  it('returns false when both result and isError are set', () => {
    expect(isRunningState('EACCES', true)).toBe(false);
  });
});
