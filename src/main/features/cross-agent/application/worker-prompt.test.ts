import { describe, it, expect } from 'vitest';
import { buildWorkerPrompt } from './worker-prompt';

describe('buildWorkerPrompt', () => {
  it('tells an implementer to read its task, work test-first and report with the STATUS contract', () => {
    const p = buildWorkerPrompt({ role: 'implementer', taskId: 'T-42' });
    expect(p).toContain('T-42');
    expect(p).toContain('kanban_get_task');
    expect(p).toMatch(/failing test/i);
    for (const status of ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED']) expect(p).toContain(status);
    expect(p).toMatch(/^STATUS:/m);
  });

  it('never lets a worker ask the user, brainstorm or start other agents', () => {
    const p = buildWorkerPrompt({ role: 'implementer', taskId: 'T-1' });
    expect(p).toMatch(/do not ask the user/i);
    expect(p).toMatch(/do not brainstorm/i);
    expect(p).toMatch(/do not start (other )?agents/i);
  });

  it('makes a reviewer read-only and points it at the commit range when given', () => {
    const p = buildWorkerPrompt({ role: 'reviewer', taskId: 'T-7', baseSha: 'abc1234' });
    expect(p).toMatch(/do not (modify|edit)/i);
    expect(p).toContain('abc1234..HEAD');
    expect(p).toMatch(/Critical/);
    expect(p).toMatch(/^STATUS:/m);
  });

  it('a reviewer without a base still tells it how to find the work', () => {
    const p = buildWorkerPrompt({ role: 'reviewer', taskId: 'T-7' });
    expect(p).toMatch(/git log/);
    expect(p).not.toContain('undefined');
  });

  it('marks a follow-up round and points the implementer at the review findings on the task', () => {
    const p = buildWorkerPrompt({ role: 'implementer', taskId: 'T-9', round: 2 });
    expect(p).toMatch(/follow-up round/i);
    expect(p).toMatch(/latest comments/i);
    expect(buildWorkerPrompt({ role: 'implementer', taskId: 'T-9' })).not.toMatch(/follow-up round/i);
  });
});
