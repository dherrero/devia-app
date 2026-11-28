import { describe, it, expect, vi } from 'vitest';
import { AssignAgentsUseCase, type AssignAgentsDeps } from './assign-agents.use-case';
import type { RoleAgentMap } from '../../../../shared/domain/cross-agent';

function setup(over: { current?: RoleAgentMap; available?: string[]; main?: string } = {}) {
  let current: RoleAgentMap = over.current ?? {};
  const save = vi.fn((_project: string, map: RoleAgentMap) => {
    current = map;
    return { accepted: true as const, map };
  });
  const deps: AssignAgentsDeps = {
    available: async () => over.available ?? ['claude', 'pi', 'opencode'],
    mainAgentId: () => over.main ?? 'claude',
    current: () => current,
    save,
  };
  return { uc: new AssignAgentsUseCase(deps), save, now: () => current };
}

const BOTH = { roles: ['implementer', 'reviewer'] as Array<'implementer' | 'reviewer'>, reassign: false };

describe('AssignAgentsUseCase.prepare', () => {
  it('asks about both roles when the project has no answer yet', async () => {
    const t = setup();
    const p = await t.uc.prepare('proj', BOTH);
    expect(p.kind).toBe('ask');
    if (p.kind !== 'ask') return;
    expect(p.question.roles).toEqual(['implementer', 'reviewer']);
    expect(p.question.options.map((o) => o.agentId)).toEqual(['main', 'pi', 'opencode']);
    expect(p.mainAgentId).toBe('claude');
  });

  it('does not ask when every requested role is saved and usable', async () => {
    const t = setup({ current: { implementer: 'pi', reviewer: 'main' } });
    const p = await t.uc.prepare('proj', BOTH);
    expect(p.kind).toBe('cached');
    if (p.kind !== 'cached') return;
    expect(p.text).toContain('implementer → pi');
    expect(p.text).toContain('reviewer → the main agent');
    expect(p.text).toContain('reassign');
  });

  it('asks only about the role that is missing', async () => {
    const t = setup({ current: { implementer: 'pi' } });
    const p = await t.uc.prepare('proj', BOTH);
    expect(p.kind).toBe('ask');
    if (p.kind === 'ask') expect(p.question.roles).toEqual(['reviewer']);
  });

  it('asks again only for a saved agent that is no longer usable', async () => {
    const t = setup({ current: { implementer: 'pi', reviewer: 'opencode' }, available: ['claude', 'pi'] });
    const p = await t.uc.prepare('proj', BOTH);
    expect(p.kind).toBe('ask');
    if (p.kind === 'ask') expect(p.question.roles).toEqual(['reviewer']);
  });

  it('reassign asks about every requested role even if saved', async () => {
    const t = setup({ current: { implementer: 'pi', reviewer: 'pi' } });
    const p = await t.uc.prepare('proj', { ...BOTH, reassign: true });
    expect(p.kind).toBe('ask');
    if (p.kind === 'ask') expect(p.question.roles).toEqual(['implementer', 'reviewer']);
  });

  it('only asks about the roles the plan uses', async () => {
    const t = setup();
    const p = await t.uc.prepare('proj', { roles: ['reviewer'], reassign: false });
    expect(p.kind === 'ask' && p.question.roles).toEqual(['reviewer']);
  });

  it('does not ask when there is nothing to choose between (only the main agent is usable)', async () => {
    const t = setup({ available: ['claude'] });
    const p = await t.uc.prepare('proj', BOTH);
    expect(p.kind).toBe('cached');
    if (p.kind === 'cached') expect(p.text).toMatch(/only the main agent/i);
  });
});

describe('AssignAgentsUseCase.finish', () => {
  it('saves the chosen agents merged with what the project already had, and says so', async () => {
    const t = setup({ current: { implementer: 'pi' } });
    const p = await t.uc.prepare('proj', BOTH);
    if (p.kind !== 'ask') throw new Error('expected a question');
    const text = await t.uc.finish('proj', p.question, '1. c');
    expect(t.save).toHaveBeenCalledWith('proj', { implementer: 'pi', reviewer: 'opencode' });
    expect(text).toContain('reviewer → opencode');
    expect(text).toContain('devia_spawn_agent');
  });

  it('records "a" as the explicit main agent so it is not asked again', async () => {
    const t = setup();
    const p = await t.uc.prepare('proj', BOTH);
    if (p.kind !== 'ask') throw new Error('expected a question');
    await t.uc.finish('proj', p.question, '1. a\n2. b');
    expect(t.now()).toEqual({ implementer: 'main', reviewer: 'pi' });
  });

  it('changes nothing and tells the agent when the answer cannot be read', async () => {
    const t = setup({ current: { implementer: 'pi' } });
    const p = await t.uc.prepare('proj', BOTH);
    if (p.kind !== 'ask') throw new Error('expected a question');
    const text = await t.uc.finish('proj', p.question, 'whatever');
    expect(t.save).not.toHaveBeenCalled();
    expect(text).toMatch(/nothing changed/i);
  });

  it('reports a save the store refused instead of claiming success', async () => {
    const t = setup();
    t.save.mockReturnValueOnce({ accepted: false, reason: 'Unknown agent id "pi".' } as never);
    const p = await t.uc.prepare('proj', BOTH);
    if (p.kind !== 'ask') throw new Error('expected a question');
    const text = await t.uc.finish('proj', p.question, '1. b\n2. b');
    expect(text).toMatch(/could not be saved/i);
    expect(text).toContain('Unknown agent id');
  });
});
