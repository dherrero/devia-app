import { describe, it, expect, vi } from 'vitest';
import { prepareHandoffsAfterAgentChange } from './agent-switch-handoff';

interface Rec { agentSessionAgentId: string | null; activeSessionId: string | null; preferredAgentId: string | null }

function setup(records: Record<string, Rec>, effective: Record<string, string>) {
  const prepare = vi.fn();
  const run = (projectPath?: string) =>
    prepareHandoffsAfterAgentChange({
      projectPath,
      entries: () => Object.entries(records)[Symbol.iterator]() as never,
      effectiveAgentId: (p) => effective[p] ?? 'claude',
      isPaneKey: (k) => k.startsWith('pane-'),
      loadMessages: () => [{ role: 'user' }, { role: 'assistant' }],
      prepare,
    });
  return { run, prepare };
}

const rec = (owner: string | null, preferred: string | null = null): Rec => ({
  agentSessionAgentId: owner,
  activeSessionId: 's1',
  preferredAgentId: preferred,
});

describe('prepareHandoffsAfterAgentChange (S-53)', () => {
  it('a project-scoped change only touches that project', () => {
    const t = setup({ a: rec('claude'), b: rec('claude') }, { a: 'codex', b: 'claude' });
    t.run('a');
    expect(t.prepare).toHaveBeenCalledTimes(1);
    expect(t.prepare.mock.calls[0]?.[0]).toBe('a');
  });

  it('a global change skips projects that carry their own agent', () => {
    const t = setup({ a: rec('claude', 'claude'), b: rec('claude') }, { a: 'claude', b: 'codex' });
    t.run(undefined);
    expect(t.prepare).toHaveBeenCalledTimes(1);
    expect(t.prepare.mock.calls[0]?.[0]).toBe('b');
  });

  it('skips a project whose session owner already matches its effective agent', () => {
    const t = setup({ a: rec('codex') }, { a: 'codex' });
    t.run('a');
    expect(t.prepare).not.toHaveBeenCalled();
  });

  it('skips pane keys and records without an active session or owner', () => {
    const t = setup(
      { 'pane-1': rec('claude'), a: { ...rec('claude'), activeSessionId: null }, b: rec(null) },
      { 'pane-1': 'codex', a: 'codex', b: 'codex' },
    );
    t.run(undefined);
    expect(t.prepare).not.toHaveBeenCalled();
  });
});
