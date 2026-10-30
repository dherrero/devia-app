/**
 * Tests for the REV-AGENT-CORE-002 persisted-event-log helpers.
 *
 * Located under `src/main/` so Vitest (which is configured to scan
 * `src/main/**\/*.test.ts`) picks it up. The module under test lives in
 * `shared/domain/` and has no runtime dependencies on either side.
 */

import { describe, it, expect } from 'vitest';
import {
  appendAgentEvent,
  isValidEventLog,
  rebuildFromEvents,
  type PersistedAgentEvent,
} from '../../shared/domain/persisted-agent-event';
import type { AgentEvent } from '../../shared/domain/agent-event';

function feed(events: AgentEvent[]): PersistedAgentEvent[] {
  return events.reduce<PersistedAgentEvent[]>(
    (acc, ev) => appendAgentEvent(acc, ev),
    [],
  );
}

describe('appendAgentEvent — coalescing', () => {
  it('collapses consecutive text_delta events into one kind:text entry', () => {
    const out = feed([
      { type: 'text_delta', delta: 'Hello, ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'text_delta', delta: '!' },
    ]);
    expect(out).toEqual([{ kind: 'text', text: 'Hello, world!' }]);
  });

  it('opens a new text entry when interrupted by a non-text event', () => {
    const out = feed([
      { type: 'text_delta', delta: 'before ' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'text_delta', delta: 'after ' },
      { type: 'text_delta', delta: 'tool' },
    ]);
    expect(out).toEqual([
      { kind: 'text', text: 'before ' },
      { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'text', text: 'after tool' },
    ]);
  });

  it('collapses thinking_delta runs into a single kind:thinking entry', () => {
    const out = feed([
      { type: 'thinking_start' },
      { type: 'thinking_delta', delta: 'Step 1: ' },
      { type: 'thinking_delta', delta: 'understand the problem.' },
      { type: 'text_delta', delta: 'Visible answer.' },
    ]);
    expect(out).toEqual([
      { kind: 'thinking', text: 'Step 1: understand the problem.' },
      { kind: 'text', text: 'Visible answer.' },
    ]);
  });

  it('drops thinking_start as a structural marker only', () => {
    const out = feed([{ type: 'thinking_start' }]);
    expect(out).toEqual([]);
  });

  it('preserves tool_use input, tool_result error flag, usage fields, turn_end, session_started, raw, status', () => {
    const out = feed([
      { type: 'status', label: 'initialising', model: 'claude-sonnet-4-5', ttftMs: 120 },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', toolUseId: 't1', content: '/tmp', isError: false },
      { type: 'usage', inputTokens: 100, outputTokens: 50, costUsd: 0.001, durationMs: 1234 },
      { type: 'session_started', agentSessionId: 'abc' },
      { type: 'raw', line: '{"some": "raw"}' },
      { type: 'error', message: 'Boom', classification: 'crash' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ]);
    expect(out).toEqual([
      { kind: 'status', label: 'initialising', model: 'claude-sonnet-4-5', ttftMs: 120 },
      { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
      { kind: 'tool_result', toolUseId: 't1', content: '/tmp', isError: false },
      { kind: 'usage', inputTokens: 100, outputTokens: 50, costUsd: 0.001, durationMs: 1234 },
      { kind: 'session_started', agentSessionId: 'abc' },
      { kind: 'raw', line: '{"some": "raw"}' },
      { kind: 'error', message: 'Boom', classification: 'crash' },
      { kind: 'turn_end', stopReason: 'end_turn' },
    ]);
  });

  it('never mutates the input array (pure function)', () => {
    const input: PersistedAgentEvent[] = [{ kind: 'text', text: 'hello' }];
    const frozen = Object.freeze(input);
    appendAgentEvent(frozen, { type: 'text_delta', delta: ' world' });
    appendAgentEvent(frozen, { type: 'tool_use', id: 't1', name: 'Bash', input: {} });
    expect(frozen).toEqual([{ kind: 'text', text: 'hello' }]);
  });
});

describe('rebuildFromEvents', () => {
  it('rebuilds text + tool_use ordering into contentBlocks correctly', () => {
    const log: PersistedAgentEvent[] = [
      { kind: 'text', text: 'Voy a revisar. ' },
      { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', toolUseId: 't1', content: 'foo.txt\n', isError: false },
      { kind: 'text', text: 'Encontré un fichero.' },
    ];
    const result = rebuildFromEvents(log);
    expect(result.text).toBe('Voy a revisar. Encontré un fichero.');
    expect(result.contentBlocks).toEqual([
      { kind: 'text', text: 'Voy a revisar. ' },
      { kind: 'tool_ref', toolCallId: 't1' },
      { kind: 'text', text: 'Encontré un fichero.' },
    ]);
    expect(result.toolCalls).toEqual([
      { id: 't1', name: 'Bash', input: { command: 'ls' }, result: 'foo.txt\n', isError: false },
    ]);
  });

  it('rebuilds thinking from multiple kind:thinking entries', () => {
    const log: PersistedAgentEvent[] = [
      { kind: 'thinking', text: 'First. ' },
      { kind: 'text', text: 'visible' },
      { kind: 'thinking', text: 'Second.' },
    ];
    const result = rebuildFromEvents(log);
    expect(result.thinking).toBe('First. Second.');
    expect(result.text).toBe('visible');
  });

  it('keeps the last usage entry only (per-turn snapshot)', () => {
    const log: PersistedAgentEvent[] = [
      { kind: 'usage', inputTokens: 10, outputTokens: 5 },
      { kind: 'usage', inputTokens: 100, outputTokens: 50, costUsd: 0.002 },
    ];
    const result = rebuildFromEvents(log);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, costUsd: 0.002 });
  });

  it('merges usage entries so the run-end cost event keeps earlier context tokens', () => {
    const log: PersistedAgentEvent[] = [
      { kind: 'usage', inputTokens: 2, cachedInputTokens: 84_106 },
      { kind: 'usage', outputTokens: 2380, inputTokens: 2, cachedInputTokens: 84_106 },
      { kind: 'usage', costUsd: 0.86, durationMs: 90_650, contextWindow: 1_000_000 },
    ];
    expect(rebuildFromEvents(log).usage).toEqual({
      inputTokens: 2,
      cachedInputTokens: 84_106,
      outputTokens: 2380,
      costUsd: 0.86,
      durationMs: 90_650,
      contextWindow: 1_000_000,
    });
  });

  it('persists cached tokens, reasoning tokens and the context window from live usage', () => {
    const log = appendAgentEvent([], {
      type: 'usage', inputTokens: 2, cachedInputTokens: 500, reasoningOutputTokens: 7, contextWindow: 1_000_000,
    });
    expect(log).toEqual([
      { kind: 'usage', inputTokens: 2, cachedInputTokens: 500, reasoningOutputTokens: 7, contextWindow: 1_000_000 },
    ]);
  });

  it('captures the last session_started.agentSessionId', () => {
    const log: PersistedAgentEvent[] = [
      { kind: 'session_started', agentSessionId: 'sess-1' },
    ];
    const result = rebuildFromEvents(log);
    expect(result.agentSessionId).toBe('sess-1');
  });

  it('returns empty defaults for an empty log', () => {
    const result = rebuildFromEvents([]);
    expect(result).toEqual({ text: '', thinking: '', toolCalls: [], contentBlocks: [] });
  });

  it('tool_result without a matching tool_use is silently skipped', () => {
    const log: PersistedAgentEvent[] = [
      { kind: 'tool_result', toolUseId: 'unknown', content: 'orphan', isError: false },
    ];
    const result = rebuildFromEvents(log);
    expect(result.toolCalls).toEqual([]);
  });
});

describe('isValidEventLog', () => {
  it('returns true for a valid array of persisted events', () => {
    const log: PersistedAgentEvent[] = [
      { kind: 'text', text: 'hi' },
      { kind: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ];
    expect(isValidEventLog(log)).toBe(true);
  });

  it('returns true for an empty array', () => {
    expect(isValidEventLog([])).toBe(true);
  });

  it('returns false for non-array values', () => {
    expect(isValidEventLog(null)).toBe(false);
    expect(isValidEventLog(undefined)).toBe(false);
    expect(isValidEventLog('text')).toBe(false);
    expect(isValidEventLog({ kind: 'text' })).toBe(false);
  });

  it('returns false when any entry lacks a known kind', () => {
    expect(isValidEventLog([{ kind: 'unknown_future_kind', text: 'x' }])).toBe(false);
    expect(isValidEventLog([{ text: 'no kind' }])).toBe(false);
    expect(isValidEventLog([null])).toBe(false);
  });
});

describe('rebuildFromEvents — partial event log scenarios', () => {
  it('handles a log with only text events (no tool calls)', () => {
    const log: PersistedAgentEvent[] = [
      { kind: 'text', text: 'Just a plain text reply.' },
    ];
    const result = rebuildFromEvents(log);
    expect(result.text).toBe('Just a plain text reply.');
    expect(result.toolCalls).toEqual([]);
    expect(result.contentBlocks).toEqual([{ kind: 'text', text: 'Just a plain text reply.' }]);
  });

  it('handles a log with only tool_use events (no text)', () => {
    const log: PersistedAgentEvent[] = [
      { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ];
    const result = rebuildFromEvents(log);
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([{ id: 't1', name: 'Bash', input: { command: 'ls' } }]);
    expect(result.contentBlocks).toEqual([{ kind: 'tool_ref', toolCallId: 't1' }]);
  });
});

describe('round-trip: live stream → events[] → rebuild matches', () => {
  it('contentBlocks and toolCalls rebuilt from events match a live consumeAgentEvent simulation', () => {
    const live: AgentEvent[] = [
      { type: 'text_delta', delta: 'Voy a usar Bash. ' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', toolUseId: 't1', content: '/tmp', isError: false },
      { type: 'text_delta', delta: 'Resultado: ' },
      { type: 'text_delta', delta: '/tmp' },
      { type: 'usage', inputTokens: 50, outputTokens: 20 },
      { type: 'turn_end', stopReason: 'end_turn' },
    ];
    const log = feed(live);
    const rebuilt = rebuildFromEvents(log);

    expect(rebuilt.text).toBe('Voy a usar Bash. Resultado: /tmp');
    expect(rebuilt.contentBlocks).toEqual([
      { kind: 'text', text: 'Voy a usar Bash. ' },
      { kind: 'tool_ref', toolCallId: 't1' },
      { kind: 'text', text: 'Resultado: /tmp' },
    ]);
    expect(rebuilt.toolCalls).toEqual([
      { id: 't1', name: 'Bash', input: { command: 'pwd' }, result: '/tmp', isError: false },
    ]);
    expect(rebuilt.usage).toEqual({ inputTokens: 50, outputTokens: 20 });
  });
});
