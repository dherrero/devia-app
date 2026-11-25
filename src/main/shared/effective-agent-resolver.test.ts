import { describe, it, expect } from 'vitest';
import { createEffectiveAgentResolver } from './effective-agent-resolver';

function setup(opts: {
  global?: string;
  projects?: Record<string, string | null>;
  agents?: Record<string, string | undefined>; // id -> providerType ('cli' | undefined = cli | other)
  sessionAgent?: (project: string, sessionId: string) => string | null | undefined;
}) {
  const agents = opts.agents ?? { claude: 'cli', codex: 'cli', pi: 'cli' };
  return createEffectiveAgentResolver({
    config: { get: () => ({ agentId: opts.global ?? 'claude' }) },
    registry: {
      find: (p: string) =>
        p in (opts.projects ?? {}) ? ({ preferredAgentId: opts.projects?.[p] ?? null } as never) : undefined,
    },
    agents: { get: (id: string) => (id in agents ? { providerType: agents[id] } : null) },
    ...(opts.sessionAgent && { sessionAgentId: opts.sessionAgent }),
  });
}

describe('createEffectiveAgentResolver', () => {
  it('follows the global agent for a project with no override', () => {
    const r = setup({ projects: { a: null } });
    expect(r.forRun('a')).toEqual({ agentId: 'claude', source: 'global' });
  });

  it('follows the global agent for an unknown project', () => {
    expect(setup({}).forRun('nope')).toEqual({ agentId: 'claude', source: 'global' });
  });

  it('uses the project agent and keeps two projects independent', () => {
    const r = setup({ projects: { a: 'codex', b: 'pi' } });
    expect(r.forRun('a').agentId).toBe('codex');
    expect(r.forRun('b').agentId).toBe('pi');
  });

  it('ignores a project agent that is not a CLI provider and reports the fallback', () => {
    const r = setup({ projects: { a: 'api-thing' }, agents: { claude: 'cli', 'api-thing': 'api' } });
    expect(r.forRun('a')).toEqual({
      agentId: 'claude',
      source: 'global',
      fellBackFrom: { source: 'project', agentId: 'api-thing' },
    });
  });

  it('ignores a project agent that was uninstalled (unknown id)', () => {
    const r = setup({ projects: { a: 'gone' } });
    expect(r.forRun('a').fellBackFrom).toEqual({ source: 'project', agentId: 'gone' });
  });

  it('lets the session agent win when a lookup is provided', () => {
    const r = setup({ projects: { a: 'codex' }, sessionAgent: (_p, s) => (s === 's1' ? 'pi' : null) });
    expect(r.forRun('a', 's1')).toEqual({ agentId: 'pi', source: 'session' });
    expect(r.forRun('a', 's2').agentId).toBe('codex');
    expect(r.forRun('a').agentId).toBe('codex');
  });

  it('treats a missing providerType as a CLI', () => {
    const r = setup({ projects: { a: 'legacy' }, agents: { claude: 'cli', legacy: undefined } });
    expect(r.forRun('a')).toEqual({ agentId: 'legacy', source: 'project' });
  });
});
