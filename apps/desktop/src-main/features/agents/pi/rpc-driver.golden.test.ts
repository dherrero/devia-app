/**
 * Contract C golden test: real pi `--mode rpc` output recorded by the agent
 * E2E harness must keep decoding to the canonical events the core relies on.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '../../../../shared/domain/agent-event';
import { DEVIA_MCP_SERVER_IDS, mapPiRpcEvent, type PiMapContext } from './rpc-driver';

function decode(fixture: string): { events: AgentEvent[]; settled: boolean } {
  const events: AgentEvent[] = [];
  const ctx: PiMapContext = { startedAt: 0, firstToken: { value: false }, costUsd: { value: 0 }, contextWindow: { value: undefined }, mcpServerIds: DEVIA_MCP_SERVER_IDS };
  let settled = false;
  for (const line of fs.readFileSync(path.join(__dirname, '__fixtures__', fixture), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record['type'] === 'response' || record['type'] === 'extension_ui_request') continue;
    if (mapPiRpcEvent(record, (e) => events.push(e), ctx)) settled = true;
  }
  return { events, settled };
}

describe('pi rpc fixtures', () => {
  it('apply: Devia tools under their canonical names, usage, settles exactly once', () => {
    const { events, settled } = decode('apply.jsonl');
    const tools = events.filter((e): e is Extract<AgentEvent, { type: 'tool_use' }> => e.type === 'tool_use').map((e) => e.name);
    expect(tools).toEqual(expect.arrayContaining(['mcp__devia-ui__devia_ask_user', 'mcp__devia-memory__mem_save', 'mcp__devia-kanban__kanban_create_spec']));
    expect(tools.some((t) => t.startsWith('mcp__devia_'))).toBe(false);
    expect(events.some((e) => e.type === 'usage' && (e.cachedInputTokens ?? -1) >= 0)).toBe(true);
    expect(settled).toBe(true);
    expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(1);
  });

  it('plan: keeps the MCP tools and calls no writer', () => {
    const { events } = decode('plan.jsonl');
    const tools = events.filter((e): e is Extract<AgentEvent, { type: 'tool_use' }> => e.type === 'tool_use').map((e) => e.name);
    expect(tools).toContain('mcp__devia-kanban__kanban_list_specs');
    expect(tools.some((t) => ['write', 'edit', 'bash'].includes(t))).toBe(false);
  });
});
