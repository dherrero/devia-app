import { describe, it, expect, vi } from 'vitest';
import { SetContextAgentUseCase } from './set-context-agent.use-case';
import { GetEffectiveAgentUseCase } from './get-effective-agent.use-case';
import { createEffectiveAgentResolver } from '../../../shared/effective-agent-resolver';
import { InMemoryProjectRegistry } from '../../claude-runner/infrastructure/in-memory-project-registry';

function setup(globalAgentId = 'claude') {
  const defs: Record<string, { providerType?: string }> = {
    claude: { providerType: 'cli' },
    codex: { providerType: 'cli' },
    'api-thing': { providerType: 'api' },
  };
  const agents = { get: (id: string) => defs[id] ?? null };
  const projects = new InMemoryProjectRegistry();
  const state = { load: vi.fn(), save: vi.fn() };
  const effective = createEffectiveAgentResolver({
    config: { get: () => ({ agentId: globalAgentId }) },
    registry: projects,
    agents,
  });
  const onSelected = vi.fn();
  const uc = new SetContextAgentUseCase({ agents, projects, state, effective, onSelected });
  return { uc, projects, state, effective, onSelected };
}

describe('SetContextAgentUseCase — project scope', () => {
  it('stores a valid CLI agent on the project, saves state and reports the effective agent', () => {
    const t = setup();
    const r = t.uc.execute({ scope: 'project', projectPath: 'a', agentId: 'codex' });
    expect(r.accepted).toBe(true);
    expect(r.effective).toEqual({ agentId: 'codex', source: 'project' });
    expect(t.projects.getOrCreate('a').preferredAgentId).toBe('codex');
    expect(t.state.save).toHaveBeenCalledOnce();
  });

  it('rejects an unknown agent and leaves the project untouched', () => {
    const t = setup();
    const r = t.uc.execute({ scope: 'project', projectPath: 'a', agentId: 'nope' });
    expect(r.accepted).toBe(false);
    expect(r.rejectedReason).toMatch(/Unknown agent/);
    expect(t.projects.getOrCreate('a').preferredAgentId).toBeNull();
    expect(t.state.save).not.toHaveBeenCalled();
  });

  it('rejects a non-CLI provider', () => {
    const t = setup();
    const r = t.uc.execute({ scope: 'project', projectPath: 'a', agentId: 'api-thing' });
    expect(r.accepted).toBe(false);
    expect(t.projects.getOrCreate('a').preferredAgentId).toBeNull();
  });

  it('rejects the change while a run is active in that project', () => {
    const t = setup();
    vi.spyOn(t.projects, 'isRunning').mockReturnValue(true);
    const r = t.uc.execute({ scope: 'project', projectPath: 'a', agentId: 'codex' });
    expect(r).toMatchObject({ accepted: false, rejectedReason: 'AGENT_RUN_ACTIVE' });
    expect(t.projects.getOrCreate('a').preferredAgentId).toBeNull();
  });

  it('agentId null removes the override and the project follows the global agent again', () => {
    const t = setup('claude');
    t.uc.execute({ scope: 'project', projectPath: 'a', agentId: 'codex' });
    const r = t.uc.execute({ scope: 'project', projectPath: 'a', agentId: null });
    expect(r.accepted).toBe(true);
    expect(r.effective).toEqual({ agentId: 'claude', source: 'global' });
    expect(t.projects.getOrCreate('a').preferredAgentId).toBeNull();
  });

  it('notifies only for the changed project', () => {
    const t = setup();
    t.uc.execute({ scope: 'project', projectPath: 'a', agentId: 'codex' });
    expect(t.onSelected).toHaveBeenCalledWith('codex', 'a');
  });

  it('does not touch another project', () => {
    const t = setup();
    t.projects.getOrCreate('b');
    t.uc.execute({ scope: 'project', projectPath: 'a', agentId: 'codex' });
    expect(t.projects.getOrCreate('b').preferredAgentId).toBeNull();
  });

  it('session scope is not available until the session agent lands', () => {
    const t = setup();
    const r = t.uc.execute({ scope: 'session', projectPath: 'a', sessionId: 's', agentId: 'codex' });
    expect(r).toMatchObject({ accepted: false, rejectedReason: 'SCOPE_UNSUPPORTED' });
  });
});

describe('GetEffectiveAgentUseCase', () => {
  it('reports global, project and fallback', () => {
    const t = setup('claude');
    const get = new GetEffectiveAgentUseCase({ effective: t.effective });
    expect(get.execute({ projectPath: 'a' })).toEqual({ agentId: 'claude', source: 'global' });
    t.projects.getOrCreate('a').preferredAgentId = 'codex';
    expect(get.execute({ projectPath: 'a' })).toEqual({ agentId: 'codex', source: 'project' });
    t.projects.getOrCreate('a').preferredAgentId = 'gone';
    expect(get.execute({ projectPath: 'a' })).toEqual({
      agentId: 'claude',
      source: 'global',
      fellBackFrom: { source: 'project', agentId: 'gone' },
    });
  });
});
