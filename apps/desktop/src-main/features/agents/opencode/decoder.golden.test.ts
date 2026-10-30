/**
 * Contract C golden test: real `opencode run --format json` output recorded by
 * the agent E2E harness must keep decoding to the canonical events.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '../../../../shared/domain/agent-event';
import { createOpencodeEventStreamParser } from './decoder';

function decode(fixture: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  const parser = createOpencodeEventStreamParser((e) => events.push(e));
  parser.feed(fs.readFileSync(path.join(__dirname, '__fixtures__', fixture), 'utf8'));
  parser.flush();
  return events;
}

describe('OpenCode json fixtures', () => {
  it('apply: announces its native session once and reports Devia tool calls', () => {
    const events = decode('apply.jsonl');
    expect(events.filter((e) => e.type === 'session_started')).toHaveLength(1);
    const tools = events.filter((e): e is Extract<AgentEvent, { type: 'tool_use' }> => e.type === 'tool_use').map((e) => e.name);
    expect(tools).toEqual(expect.arrayContaining(['devia-ui_devia_ask_user', 'devia-memory_mem_save']));
    expect(events.some((e) => e.type === 'usage')).toBe(true);
  });
});
