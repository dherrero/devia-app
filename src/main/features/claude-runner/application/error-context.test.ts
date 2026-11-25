import { describe, it, expect } from 'vitest';
import { buildExplainContext } from './error-context';
import type { DeviaConfig } from '../../../../shared/domain/config';

const cfg = (over: Partial<DeviaConfig> = {}): DeviaConfig =>
  ({ agentModels: {}, agentCliEnv: {}, ...over }) as unknown as DeviaConfig;

describe('buildExplainContext', () => {
  it('carries the saved model, origin and auto-continue switch for the agent', () => {
    const ctx = buildExplainContext({
      agentId: 'claude',
      cfg: cfg({ agentModels: { claude: { model: 'sonnet' } }, autoContinueSessions: { claude: true } }),
      origin: 'remote',
      env: {},
    });
    expect(ctx).toMatchObject({ agentId: 'claude', configuredModel: 'sonnet', autoContinueEnabled: true, origin: 'remote' });
  });

  it('treats an empty model as not configured and an absent switch as off', () => {
    const ctx = buildExplainContext({ agentId: 'pi', cfg: cfg({ agentModels: { pi: { model: '' } } }), origin: 'renderer', env: {} });
    expect(ctx.configuredModel).toBeUndefined();
    expect(ctx.autoContinueEnabled).toBe(false);
  });

  it('lists only the NAMES of provider credential variables that are set, never values', () => {
    const ctx = buildExplainContext({
      agentId: 'opencode',
      cfg: cfg({ agentCliEnv: { opencode: { OPENROUTER_API_KEY: 'sk-or-secret-value-123456', FOO: 'x' } } }),
      origin: 'renderer',
      env: { OPENAI_API_KEY: 'sk-secret-value-abcdef', PATH: '/bin', ANTHROPIC_API_KEY: '' },
    });
    expect([...ctx.inheritedProviderEnv].sort()).toEqual(['OPENAI_API_KEY', 'OPENROUTER_API_KEY']);
    expect(JSON.stringify(ctx)).not.toContain('secret-value');
  });

  it('passes resetsAt through when the agent reported it', () => {
    const ctx = buildExplainContext({ agentId: 'claude', cfg: cfg(), origin: 'renderer', env: {}, resetsAt: 1_900_000_000_000 });
    expect(ctx.resetsAt).toBe(1_900_000_000_000);
  });
});
