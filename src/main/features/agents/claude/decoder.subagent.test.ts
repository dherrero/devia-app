/**
 * S-49: Claude Code sub-agent streams (real captures, Claude 2.1.322). The
 * sub-agent's own lines carry `parent_tool_use_id`; its progress comes as
 * `system/task_*`. None of it may leak into the main thread's text.
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

type ToolUse = Extract<AgentEvent, { type: 'tool_use' }>;
type Sub = Extract<AgentEvent, { type: 'subagent' }>;
const toolUses = (e: AgentEvent[]) => e.filter((x): x is ToolUse => x.type === 'tool_use');
const subs = (e: AgentEvent[]) => e.filter((x): x is Sub => x.type === 'subagent');

describe.each(['subagent-partial.jsonl', 'subagent-nopartial.jsonl'])('%s', (fixture) => {
  const events = decode(fixture);

  it('emits the Agent call at top level and the sub-agent tool call nested under it', () => {
    const agent = toolUses(events).find((t) => t.name === 'Agent');
    expect(agent?.parentToolUseId).toBeUndefined();
    const children = toolUses(events).filter((t) => t.parentToolUseId === agent?.id);
    expect(children.length).toBeGreaterThanOrEqual(1);
  });

  it('emits the sub-agent child tool_result', () => {
    const child = toolUses(events).find((t) => t.parentToolUseId !== undefined);
    const result = events.find((e) => e.type === 'tool_result' && e.toolUseId === child?.id);
    expect(result).toMatchObject({ type: 'tool_result', content: expect.stringMatching(/\S/), isError: false });
  });

  it('reports the sub-agent lifecycle: running with description, then completed with summary', () => {
    const agent = toolUses(events).find((t) => t.name === 'Agent');
    const mine = subs(events).filter((s) => s.toolUseId === agent?.id);
    expect(mine[0]).toMatchObject({ status: 'running', subagentType: 'general-purpose' });
    expect(mine[0]?.description).toMatch(/a\.txt/);
    expect(mine.at(-1)).toMatchObject({ status: 'completed' });
    expect(mine.at(-1)?.summary).toContain('alpha');
  });

  it('keeps the sub-agent hand-back text out of the main thread text', () => {
    const text = events.filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta').map((e) => e.delta).join('');
    expect(text).not.toContain('Subagent hand-back');
    expect(text).not.toContain('Report its full content');
  });
});

describe('subagent-parallel-nopartial.jsonl', () => {
  const events = decode('subagent-parallel-nopartial.jsonl');

  it('keeps two parallel sub-agents apart', () => {
    const agents = toolUses(events).filter((t) => t.name === 'Agent');
    expect(agents).toHaveLength(2);
    for (const agent of agents) {
      expect(toolUses(events).filter((t) => t.parentToolUseId === agent.id)).toHaveLength(1);
      expect(subs(events).some((s) => s.toolUseId === agent.id && s.status === 'completed')).toBe(true);
    }
  });

  it('does not paste the sub-agents\' own text or thinking into the main thread', () => {
    const lines = fs.readFileSync(path.join(__dirname, '__fixtures__', 'subagent-parallel-nopartial.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const childTexts = lines
      .filter((l) => l['type'] === 'assistant' && typeof l['parent_tool_use_id'] === 'string')
      .flatMap((l) => ((l['message'] as { content: { type: string; text?: string }[] }).content))
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text as string);
    expect(childTexts.length).toBeGreaterThan(0);
    const main = events.filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta').map((e) => e.delta).join('');
    for (const t of childTexts) expect(main).not.toContain(t);
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(false);
  });
});
