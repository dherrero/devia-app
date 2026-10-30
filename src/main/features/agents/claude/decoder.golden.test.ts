/**
 * Contract C golden test: real Claude Code stream-json recorded by the agent
 * E2E harness (`tools/agent-e2e --record`) must keep decoding to the canonical
 * events the core relies on.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '../../../../shared/domain/agent-event';
import { createClaudeStreamParser } from './decoder';

function decode(fixture: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  const parser = createClaudeStreamParser((e) => events.push(e));
  parser.feed(fs.readFileSync(path.join(__dirname, '__fixtures__', fixture), 'utf8'));
  parser.flush();
  return events;
}

describe('Claude stream-json fixtures', () => {
  it('apply: session id, Devia tool calls under their canonical names, usage with a window, one turn end', () => {
    const events = decode('apply.jsonl');
    expect(events.some((e) => e.type === 'session_started')).toBe(true);
    const tools = events.filter((e): e is Extract<AgentEvent, { type: 'tool_use' }> => e.type === 'tool_use').map((e) => e.name);
    expect(tools).toEqual(expect.arrayContaining(['mcp__devia-ui__devia_ask_user', 'mcp__devia-memory__mem_save', 'mcp__devia-kanban__kanban_create_spec']));
    const usage = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usage.some((u) => (u.contextWindow ?? 0) > 0)).toBe(true);
    expect(usage.some((u) => (u.costUsd ?? 0) > 0)).toBe(true);
    expect(events.filter((e) => e.type === 'turn_end').length).toBeGreaterThanOrEqual(1);
  });

  it('resume: answers with text and no tool call', () => {
    const events = decode('resume.jsonl');
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'tool_use' && e.name.startsWith('mcp__devia-ui'))).toBe(false);
  });
});
