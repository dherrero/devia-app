import { describe, it, expect } from 'vitest';
import {
  MAIN_AGENT,
  WORKER_ROLES,
  isRoleSplit,
  isWorkerRunKey,
  parseWorkerRunKey,
  workerRunKey,
  buildAssignQuestion,
  parseAssignReply,
  renderAssignQuestionText,
  renderAssignRetryText,
  parseWorkerReport,
  renderWorkerReport,
  sanitizeRoleAgents,
} from './cross-agent';

describe('parseWorkerReport', () => {
  it('reads the status from the first STATUS line', () => {
    const r = parseWorkerReport('STATUS: DONE\nImplemented the thing.\ncommit abc1234');
    expect(r.status).toBe('DONE');
    expect(r.summary).toContain('Implemented the thing.');
    expect(r.commits).toEqual(['abc1234']);
  });

  it('accepts DONE_WITH_CONCERNS, NEEDS_CONTEXT and BLOCKED', () => {
    expect(parseWorkerReport('STATUS: DONE_WITH_CONCERNS\nx').status).toBe('DONE_WITH_CONCERNS');
    expect(parseWorkerReport('STATUS: NEEDS_CONTEXT\nx').status).toBe('NEEDS_CONTEXT');
    expect(parseWorkerReport('STATUS: BLOCKED\nx').status).toBe('BLOCKED');
  });

  it('falls back to BLOCKED with the raw text when no status is recognisable', () => {
    const r = parseWorkerReport('I did some stuff but forgot the contract');
    expect(r.status).toBe('BLOCKED');
    expect(r.summary).toContain('forgot the contract');
    expect(r.raw).toBe('I did some stuff but forgot the contract');
  });

  it('never throws on empty input', () => {
    expect(parseWorkerReport('').status).toBe('BLOCKED');
  });
});

describe('renderWorkerReport', () => {
  const base = { status: 'DONE' as const, summary: 'ok', commits: [], raw: 'ok' };
  const meta = { agentId: 'pi', role: 'implementer' as const, taskId: 'T-1' };

  it('labels the report with agent, role, task and status', () => {
    const out = renderWorkerReport({ ...base, ...meta });
    expect(out).toContain('pi');
    expect(out).toContain('implementer');
    expect(out).toContain('T-1');
    expect(out).toContain('DONE');
  });

  it('truncates the tail at maxChars and says so', () => {
    const out = renderWorkerReport({ ...base, ...meta, summary: 'x'.repeat(9000), raw: 'x'.repeat(9000) }, 8000);
    expect(out.length).toBeLessThan(8400);
    expect(out).toMatch(/truncated/i);
  });
});

describe('buildAssignQuestion', () => {
  it('uses a) for the main agent and b, c... for the rest in stable order', () => {
    const q = buildAssignQuestion([...WORKER_ROLES], ['claude', 'pi', 'opencode'], 'claude');
    expect(q.roles).toEqual(['implementer', 'reviewer']);
    expect(q.options).toEqual([
      { key: 'a', agentId: 'main' },
      { key: 'b', agentId: 'pi' },
      { key: 'c', agentId: 'opencode' },
    ]);
  });
});

describe('parseAssignReply', () => {
  const q = buildAssignQuestion(['implementer', 'reviewer'], ['claude', 'pi', 'opencode'], 'claude');

  it('parses "1. b\\n2. c"', () => {
    expect(parseAssignReply('1. b\n2. c', q)).toEqual({ ok: true, map: { implementer: 'pi', reviewer: 'opencode' } });
  });

  it('parses compact and uppercase forms', () => {
    expect(parseAssignReply('1b 2c', q)).toEqual({ ok: true, map: { implementer: 'pi', reviewer: 'opencode' } });
    expect(parseAssignReply('1) B  2) A', q)).toEqual({ ok: true, map: { implementer: 'pi', reviewer: MAIN_AGENT } });
  });

  it('asks again only for the invalid role and returns no partial map', () => {
    expect(parseAssignReply('1.b, 2 z', q)).toEqual({ ok: false, retryRoles: ['reviewer'] });
  });

  it('asks again for a missing line', () => {
    expect(parseAssignReply('1. b', q)).toEqual({ ok: false, retryRoles: ['reviewer'] });
  });

  it('asks again for everything on garbage', () => {
    expect(parseAssignReply('whatever', q)).toEqual({ ok: false, retryRoles: ['implementer', 'reviewer'] });
  });
});

describe('sanitizeRoleAgents', () => {
  it('keeps known roles with a non-empty string agent', () => {
    expect(sanitizeRoleAgents({ implementer: 'pi', reviewer: 'opencode' })).toEqual({ implementer: 'pi', reviewer: 'opencode' });
  });

  it('drops unknown roles, empty and non-string values', () => {
    expect(sanitizeRoleAgents({ implementer: 'pi', architect: 'x', reviewer: 7 })).toEqual({ implementer: 'pi' });
    expect(sanitizeRoleAgents({ implementer: '' })).toEqual({});
  });

  it('returns an empty map for anything that is not a plain object', () => {
    for (const bad of [null, undefined, 'pi', 3, ['pi']]) expect(sanitizeRoleAgents(bad)).toEqual({});
  });
});

describe('explicit main agent in the role map (S-56 T9)', () => {
  const q = buildAssignQuestion(['implementer', 'reviewer'], ['claude', 'pi'], 'claude');

  it('records a choice of "a" as the main agent, so it is not asked again', () => {
    expect(parseAssignReply('1. a\n2. a', q)).toEqual({ ok: true, map: { implementer: MAIN_AGENT, reviewer: MAIN_AGENT } });
  });

  it('isRoleSplit is true only for a real agent', () => {
    expect(isRoleSplit({ implementer: 'pi' }, 'implementer')).toBe(true);
    expect(isRoleSplit({ implementer: MAIN_AGENT }, 'implementer')).toBe(false);
    expect(isRoleSplit({}, 'implementer')).toBe(false);
  });

  it('sanitizeRoleAgents keeps the explicit main marker', () => {
    expect(sanitizeRoleAgents({ implementer: MAIN_AGENT, reviewer: 'pi' })).toEqual({ implementer: MAIN_AGENT, reviewer: 'pi' });
  });
});

describe('worker run keys (S-56)', () => {
  it('round-trips parent, task and attempt', () => {
    expect(parseWorkerRunKey(workerRunKey('proj-a', 'T-12', 3))).toEqual({ parentKey: 'proj-a', taskId: 'T-12', attempt: 3 });
  });

  it('keeps a parent that contains colons or slashes intact', () => {
    expect(parseWorkerRunKey(workerRunKey('apps/web:v2', 'T-1', 1))?.parentKey).toBe('apps/web:v2');
    expect(parseWorkerRunKey(workerRunKey('9f1c2d3e-aaaa-bbbb-cccc-111122223333', 'T-1', 1))?.parentKey).toBe(
      '9f1c2d3e-aaaa-bbbb-cccc-111122223333',
    );
  });

  it('returns null for anything that is not a worker key', () => {
    for (const key of ['proj-a', '', 'devia-worker:', 'devia-worker:proj-a', 'devia-worker:proj-a:T-1', 'x:devia-worker:a:T-1:1']) {
      expect(parseWorkerRunKey(key)).toBeNull();
    }
    expect(isWorkerRunKey('devia-worker:a:T-1:1')).toBe(true);
  });
});

describe('Telegram text of the assignment question (S-56 T12)', () => {
  const q = buildAssignQuestion(['implementer', 'reviewer'], ['claude', 'pi', 'opencode'], 'claude');

  it('lists every role with lettered options, the main agent first', () => {
    const text = renderAssignQuestionText(q, 'claude');
    expect(text).toContain('Elige si quieres el desarrollo en multi agente:');
    expect(text).toContain('1 Tareas de desarrollo: a) Agente principal (claude), b) pi, c) opencode');
    expect(text).toContain('2 Tareas de revisión: a) Agente principal (claude), b) pi, c) opencode');
  });

  it('tells the user how to answer, with an example built from the number of roles', () => {
    expect(renderAssignQuestionText(q, 'claude')).toMatch(/Responde.*1\. b.*2\. a/s);
    const one = buildAssignQuestion(['reviewer'], ['claude', 'pi'], 'claude');
    expect(renderAssignQuestionText(one, 'claude')).toContain('1 Tareas de revisión:');
    expect(renderAssignQuestionText(one, 'claude')).not.toContain('2.');
  });

  it('is plain text: nothing Telegram Markdown would eat', () => {
    expect(renderAssignQuestionText(q, 'claude')).not.toMatch(/[*_`\[\]]/);
  });

  it('a reply the text asks for is the one parseAssignReply reads', () => {
    expect(parseAssignReply('1. b\n2. c', q)).toEqual({ ok: true, map: { implementer: 'pi', reviewer: 'opencode' } });
  });

  it('retry text asks again for ONLY the roles that failed, keeping their own numbers', () => {
    const text = renderAssignRetryText(q, 'claude', ['reviewer']);
    expect(text).toContain('revisión');
    expect(text).not.toContain('Tareas de desarrollo');
    expect(text).toContain('2 Tareas de revisión: a) Agente principal (claude), b) pi, c) opencode');
    expect(text).toMatch(/No entendí/);
  });
});
