import { describe, it, expect } from 'vitest';
import {
  listAvailableAgents,
  resolveWorkerAgent,
  type DetectedAgentLike,
} from './resolve-worker-agent';

const agent = (id: string, over: Partial<DetectedAgentLike> = {}): DetectedAgentLike => ({
  id,
  available: true,
  providerType: 'cli',
  authStatus: 'ok',
  ...over,
});

function deps(opts: { roleAgents?: Record<string, string>; detected: DetectedAgentLike[]; effective?: string }) {
  return {
    registry: { find: () => ({ roleAgents: opts.roleAgents ?? {} }) as never },
    effective: { forRun: () => ({ agentId: opts.effective ?? 'claude', source: 'global' as const }) },
    detector: {
      detectOne: async (id: string) => opts.detected.find((a) => a.id === id) ?? null,
      detectAll: async () => opts.detected,
    },
  };
}

describe('resolveWorkerAgent', () => {
  it('falls back to the effective agent when the project has no mapping', async () => {
    const r = await resolveWorkerAgent(deps({ detected: [agent('claude')] }), 'proj', 'implementer');
    expect(r).toEqual({ ok: true, agentId: 'claude' });
  });

  it('uses the role mapping of the project', async () => {
    const d = deps({ roleAgents: { implementer: 'pi', reviewer: 'opencode' }, detected: [agent('claude'), agent('pi'), agent('opencode')] });
    expect(await resolveWorkerAgent(d, 'proj', 'implementer')).toEqual({ ok: true, agentId: 'pi' });
    expect(await resolveWorkerAgent(d, 'proj', 'reviewer')).toEqual({ ok: true, agentId: 'opencode' });
  });

  it('blocks instead of substituting when the mapped agent is no longer installed', async () => {
    const d = deps({ roleAgents: { implementer: 'pi' }, detected: [agent('claude'), agent('pi', { available: false })] });
    const r = await resolveWorkerAgent(d, 'proj', 'implementer');
    expect(r).toMatchObject({ ok: false, agentId: 'pi', reason: 'not_installed' });
    expect((r as { message: string }).message).toContain('pi');
  });

  it('blocks when the mapped agent has no credentials, carrying the agent message', async () => {
    const d = deps({
      roleAgents: { reviewer: 'codex' },
      detected: [agent('claude'), agent('codex', { authStatus: 'missing', authMessage: 'Run codex login' })],
    });
    const r = await resolveWorkerAgent(d, 'proj', 'reviewer');
    expect(r).toMatchObject({ ok: false, agentId: 'codex', reason: 'not_authenticated' });
    expect((r as { message: string }).message).toContain('Run codex login');
  });

  it('treats an unknown auth state as usable (it cannot be proven missing)', async () => {
    const d = deps({ roleAgents: { implementer: 'pi' }, detected: [agent('pi', { authStatus: 'unknown' })] });
    expect(await resolveWorkerAgent(d, 'proj', 'implementer')).toEqual({ ok: true, agentId: 'pi' });
  });

  it('blocks an agent id the detector does not know', async () => {
    const d = deps({ roleAgents: { implementer: 'ghost' }, detected: [agent('claude')] });
    expect(await resolveWorkerAgent(d, 'proj', 'implementer')).toMatchObject({ ok: false, agentId: 'ghost', reason: 'unknown_agent' });
  });

  it('blocks a provider that cannot run instructions', async () => {
    const d = deps({ roleAgents: { implementer: 'api' }, detected: [agent('api', { providerType: 'api' })] });
    expect(await resolveWorkerAgent(d, 'proj', 'implementer')).toMatchObject({ ok: false, reason: 'not_executable' });
  });

  it('also validates the effective agent when there is no mapping', async () => {
    const d = deps({ detected: [agent('claude', { available: false })] });
    expect(await resolveWorkerAgent(d, 'proj', 'implementer')).toMatchObject({ ok: false, agentId: 'claude', reason: 'not_installed' });
  });
});

describe('listAvailableAgents', () => {
  it('keeps installed, authenticated CLI agents in detector order', async () => {
    const d = deps({
      detected: [
        agent('claude'),
        agent('pi'),
        agent('codex', { available: false }),
        agent('gemini', { authStatus: 'missing' }),
        agent('api', { providerType: 'api' }),
        agent('opencode', { authStatus: 'unknown' }),
      ],
    });
    expect(await listAvailableAgents(d)).toEqual(['claude', 'pi', 'opencode']);
  });
});
