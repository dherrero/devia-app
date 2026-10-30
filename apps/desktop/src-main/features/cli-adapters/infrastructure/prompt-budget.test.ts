import { describe, it, expect } from 'vitest';
import { checkPromptArgvBudget } from './prompt-budget';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';

/** Minimal stub satisfying RuntimeAgentDef for test purposes. */
function makeDef(overrides: Partial<RuntimeAgentDef> = {}): RuntimeAgentDef {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    bin: 'test-agent',
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => [],
    streamFormat: 'plain',
    systemPromptStrategy: 'unsupported',
    ...overrides,
  };
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('checkPromptArgvBudget', () => {
  it('returns null when def is null', () => {
    expect(checkPromptArgvBudget(null, 'any prompt')).toBeNull();
  });

  it('returns null when def is undefined', () => {
    expect(checkPromptArgvBudget(undefined, 'any prompt')).toBeNull();
  });

  it('returns null when def has no maxPromptArgBytes (stdin-based adapter)', () => {
    const def = makeDef({ promptViaStdin: true });
    // maxPromptArgBytes is not set
    expect(checkPromptArgvBudget(def, 'a'.repeat(1000))).toBeNull();
  });

  it('returns null when prompt is within budget', () => {
    const def = makeDef({ maxPromptArgBytes: 100 });
    const prompt = 'a'.repeat(50); // 50 bytes < 100 limit
    expect(checkPromptArgvBudget(def, prompt)).toBeNull();
  });

  it('returns null when prompt is exactly at the limit (boundary)', () => {
    const def = makeDef({ maxPromptArgBytes: 100 });
    const prompt = 'a'.repeat(100); // exactly 100 bytes
    expect(checkPromptArgvBudget(def, prompt)).toBeNull();
  });

  it('returns PromptBudgetError when prompt exceeds limit', () => {
    const def = makeDef({ maxPromptArgBytes: 100, id: 'codex', name: 'Codex CLI' });
    const prompt = 'a'.repeat(200); // 200 bytes > 100 limit
    const result = expectPresent(checkPromptArgvBudget(def, prompt));
    expect(result.code).toBe('AGENT_PROMPT_TOO_LARGE');
    expect(result.bytes).toBe(200);
    expect(result.limit).toBe(100);
  });

  it('includes agent name in error message', () => {
    const def = makeDef({ maxPromptArgBytes: 50, id: 'myagent', name: 'My Agent CLI' });
    const prompt = 'x'.repeat(100);
    const result = expectPresent(checkPromptArgvBudget(def, prompt));
    expect(result.message).toContain('My Agent CLI');
    expect(result.message).toContain('myagent');
  });

  it('correctly measures UTF-8 byte length (multi-byte chars)', () => {
    const def = makeDef({ maxPromptArgBytes: 10 });
    // Each emoji is 4 bytes in UTF-8; 3 emojis = 12 bytes > 10 limit
    const prompt = '\u{1F600}\u{1F600}\u{1F600}'; // 3 emojis
    const result = expectPresent(checkPromptArgvBudget(def, prompt));
    expect(result.bytes).toBeGreaterThan(10);
  });
});
