import { describe, it, expect } from 'vitest';
import { sanitizeForMemory, buildRunSummary, redactSensitive } from './memory-capture';

describe('redactSensitive', () => {
  it('redacts <private> regions', () => {
    expect(redactSensitive('a <private>x</private> b')).toBe('a [REDACTED] b');
  });

  it('redacts well-known token shapes', () => {
    expect(redactSensitive('key sk-ABCDEFGHIJKLMNOP1234')).toContain('[REDACTED]');
    expect(redactSensitive('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe('[REDACTED]');
    expect(redactSensitive('lt_ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('[REDACTED]');
    expect(redactSensitive('Authorization: Bearer abcdef123456ghijkl')).toContain('[REDACTED]');
  });

  it('redacts the value of secret-looking assignments, keeping the key', () => {
    const out = redactSensitive('API_KEY=supersecretvalue123');
    expect(out).toContain('API_KEY=');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('supersecretvalue123');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'Refactored the auth module and fixed a bug in the parser.';
    expect(redactSensitive(prose)).toBe(prose);
  });
});

describe('sanitizeForMemory', () => {
  it('redacts <private>…</private> regions (case-insensitive, multiline)', () => {
    const out = sanitizeForMemory('keep <PRIVATE>secret\ntoken</private> end');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('token');
  });

  it('trims and clamps to the max length with an ellipsis', () => {
    const out = sanitizeForMemory('  ' + 'a'.repeat(50) + '  ', 10);
    expect(out.length).toBe(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns short text unchanged', () => {
    expect(sanitizeForMemory('hello')).toBe('hello');
  });
});

describe('buildRunSummary', () => {
  it('reports the prompt excerpt, tool count and completed status', () => {
    const s = buildRunSummary('add a logout button', 3, 0);
    expect(s).toContain('add a logout button');
    expect(s).toContain('3 tool calls');
    expect(s).toContain('completed');
  });

  it('singularises a single tool call', () => {
    expect(buildRunSummary('x', 1, 0)).toContain('1 tool call,');
  });

  it('reports the exit code for non-zero runs', () => {
    expect(buildRunSummary('x', 0, 1)).toContain('exited 1');
  });

  it('collapses whitespace and redacts private data in the excerpt', () => {
    const s = buildRunSummary('do\n\n  <private>nope</private>  X', 2, 0);
    expect(s).not.toContain('nope');
    expect(s).not.toContain('\n');
  });
});
