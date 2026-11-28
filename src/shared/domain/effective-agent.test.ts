import { describe, it, expect } from 'vitest';
import { resolveEffectiveAgentId } from './effective-agent';

const all = () => true;

describe('resolveEffectiveAgentId', () => {
  it('uses the global agent when nothing else is set', () => {
    expect(resolveEffectiveAgentId({ globalAgentId: 'claude', isExecutable: all })).toEqual({
      agentId: 'claude',
      source: 'global',
    });
  });

  it('prefers the project agent over the global one', () => {
    const r = resolveEffectiveAgentId({ projectAgentId: 'codex', globalAgentId: 'claude', isExecutable: all });
    expect(r).toEqual({ agentId: 'codex', source: 'project' });
  });

  it('prefers the session agent over the project agent', () => {
    const r = resolveEffectiveAgentId({
      sessionAgentId: 'pi',
      projectAgentId: 'codex',
      globalAgentId: 'claude',
      isExecutable: all,
    });
    expect(r).toEqual({ agentId: 'pi', source: 'session' });
  });

  it('falls back from an invalid session agent to the project agent and reports it', () => {
    const r = resolveEffectiveAgentId({
      sessionAgentId: 'gone',
      projectAgentId: 'codex',
      globalAgentId: 'claude',
      isExecutable: (id) => id !== 'gone',
    });
    expect(r).toEqual({
      agentId: 'codex',
      source: 'project',
      fellBackFrom: { source: 'session', agentId: 'gone' },
    });
  });

  it('reports the highest-priority invalid level when falling back to global', () => {
    const r = resolveEffectiveAgentId({
      sessionAgentId: 'gone-s',
      projectAgentId: 'gone-p',
      globalAgentId: 'claude',
      isExecutable: (id) => id === 'claude',
    });
    expect(r).toEqual({
      agentId: 'claude',
      source: 'global',
      fellBackFrom: { source: 'session', agentId: 'gone-s' },
    });
  });

  it('returns the global agent even when it is not executable (hard fallback lives elsewhere)', () => {
    const r = resolveEffectiveAgentId({ globalAgentId: 'ghost', isExecutable: () => false });
    expect(r).toEqual({ agentId: 'ghost', source: 'global' });
  });

  it('treats null and empty strings as absent', () => {
    const r = resolveEffectiveAgentId({
      sessionAgentId: '',
      projectAgentId: null,
      globalAgentId: 'claude',
      isExecutable: all,
    });
    expect(r).toEqual({ agentId: 'claude', source: 'global' });
  });
});
