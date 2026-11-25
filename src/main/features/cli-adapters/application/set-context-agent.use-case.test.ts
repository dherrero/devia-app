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

});

describe('SetContextAgentUseCase — session scope', () => {
  const SID = '11111111-2222-3333-4444-555555555555';

  function sessionSetup() {
    const t = setup();
    const stored = new Map<string, string | null>();
    const sessionAgents = {
      set: vi.fn((p: string, s: string, a: string | null) => { stored.set(`${p}|${s}`, a); }),
    };
    const sessions = { isValidSessionId: (id?: string | null): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) };
    const uc = new SetContextAgentUseCase({
      agents: { get: (id: string) => (['claude', 'codex'].includes(id) ? { providerType: 'cli' } : null) },
      projects: t.projects, state: t.state, effective: t.effective, sessions, sessionAgents, onSelected: t.onSelected,
    });
    return { ...t, uc, sessionAgents };
  }

  it('stores the agent on the session, not on the project', () => {
    const t = sessionSetup();
    const r = t.uc.execute({ scope: 'session', projectPath: 'a', sessionId: SID, agentId: 'codex' });
    expect(r.accepted).toBe(true);
    expect(t.sessionAgents.set).toHaveBeenCalledWith('a', SID, 'codex');
    expect(t.projects.getOrCreate('a').preferredAgentId).toBeNull();
  });

  it('clears the session agent with null', () => {
    const t = sessionSetup();
    t.uc.execute({ scope: 'session', projectPath: 'a', sessionId: SID, agentId: null });
    expect(t.sessionAgents.set).toHaveBeenCalledWith('a', SID, null);
  });

  it('rejects a session scope without a valid session id', () => {
    const t = sessionSetup();
    expect(t.uc.execute({ scope: 'session', projectPath: 'a', agentId: 'codex' })).toMatchObject({ accepted: false, rejectedReason: 'INVALID_SESSION' });
    expect(t.uc.execute({ scope: 'session', projectPath: 'a', sessionId: 'nope', agentId: 'codex' })).toMatchObject({ accepted: false, rejectedReason: 'INVALID_SESSION' });
    expect(t.sessionAgents.set).not.toHaveBeenCalled();
  });

  it('rejects an unknown agent and a run in that pane', () => {
    const t = sessionSetup();
    expect(t.uc.execute({ scope: 'session', projectPath: 'a', sessionId: SID, agentId: 'nope' }).accepted).toBe(false);
    vi.spyOn(t.projects, 'isRunning').mockImplementation((key: string) => key === SID);
    expect(t.uc.execute({ scope: 'session', projectPath: 'a', sessionId: SID, agentId: 'codex' })).toMatchObject({ rejectedReason: 'AGENT_RUN_ACTIVE' });
  });

  it('blocks the change while the primary pane runs that very session', () => {
    const t = sessionSetup();
    t.projects.getOrCreate('a').activeSessionId = SID;
    vi.spyOn(t.projects, 'isRunning').mockImplementation((key: string) => key === 'a');
    expect(t.uc.execute({ scope: 'session', projectPath: 'a', sessionId: SID, agentId: 'codex' })).toMatchObject({ rejectedReason: 'AGENT_RUN_ACTIVE' });
  });

  it('does not run the project-wide handoff precompute', () => {
    const t = sessionSetup();
    t.uc.execute({ scope: 'session', projectPath: 'a', sessionId: SID, agentId: 'codex' });
    expect(t.onSelected).not.toHaveBeenCalled();
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
