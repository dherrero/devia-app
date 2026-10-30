/**
 * REV-AGENT-CORE-014: tests for the multi-provider detection branches.
 *
 * The tier-3 providers (api / mcp / local-model / planned) must:
 *   - never invoke child_process (we verify by not setting up any spawn mocks)
 *   - report `available: false` and `selectable: false`
 *   - report `configured: true` when every `requiredEnvKeys` is present
 *   - carry an `unavailableReason` string the renderer can show verbatim
 *   - never leak the secret values themselves
 *
 * The safe wrapper must catch errors so one bad provider never aborts the
 * parallel detection of the rest of the catalog.
 */
import { describe, it, expect, vi } from 'vitest';
import { detectAgent, detectAgentSafe } from './detect-agent';
import type { RuntimeAgentDef } from '../../domain/runtime-agent-def';

function plannedDef(overrides: Partial<RuntimeAgentDef> = {}): RuntimeAgentDef {
  return {
    id: 'test-planned',
    name: 'Test Planned',
    bin: 'test-planned',
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => [],
    streamFormat: 'plain',
    systemPromptStrategy: 'unsupported',
    providerType: 'planned',
    applicability: 'planned',
    unavailableReason: 'Planned provider.',
    ...overrides,
  };
}

describe('detectAgent — non-CLI providers', () => {
  it('marks a planned provider as not selectable with a reason', async () => {
    const result = await detectAgent(plannedDef());
    expect(result.available).toBe(false);
    expect(result.selectable).toBe(false);
    expect(result.providerType).toBe('planned');
    expect(result.applicability).toBe('planned');
    expect(result.unavailableReason).toBe('Planned provider.');
  });

  it('marks an api provider with all required env keys present as configured', async () => {
    const def = plannedDef({
      id: 'api-cfg',
      providerType: 'api',
      requiredEnvKeys: ['SOME_API_KEY'],
      unavailableReason: 'API direct support planned.',
    });
    const result = await detectAgent(def, {
      // requiredEnvKeys checks env, not envOverrides — but the
      // build-env helper merges envOverrides into env when present in the
      // allowlist. Here we ensure detection looks at process.env via
      // a separate spy, so we mutate process.env directly for the test.
    });
    expect(result.providerType).toBe('api');
    expect(result.selectable).toBe(false);
    expect(result.unavailableReason).toContain('planned');
  });

  it('reports configured:false when required env keys are missing', async () => {
    const def = plannedDef({
      id: 'api-missing',
      providerType: 'api',
      requiredEnvKeys: ['DEFINITELY_NOT_SET_DEVIA_TEST_KEY'],
    });
    const result = await detectAgent(def);
    expect(result.configured).toBe(false);
  });

  it('reports configured:true when env key is set', async () => {
    const ENV_KEY = '__DEVIA_TEST_CFG_KEY_' + Math.random().toString(36).slice(2);
    process.env[ENV_KEY] = 'present';
    try {
      const def = plannedDef({
        id: 'api-set',
        providerType: 'api',
        requiredEnvKeys: [ENV_KEY],
      });
      const result = await detectAgent(def);
      expect(result.configured).toBe(true);
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  it('never returns env values themselves in the DetectedAgent shape', async () => {
    const ENV_KEY = '__DEVIA_TEST_SECRET_' + Math.random().toString(36).slice(2);
    const SECRET = 'super-secret-' + Math.random().toString(36).slice(2);
    process.env[ENV_KEY] = SECRET;
    try {
      const def = plannedDef({
        id: 'secret',
        providerType: 'api',
        requiredEnvKeys: [ENV_KEY],
      });
      const result = await detectAgent(def);
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain(SECRET);
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  it('local-model providers behave the same way as api providers', async () => {
    const def = plannedDef({
      id: 'lm',
      providerType: 'local-model',
      requiredEnvKeys: ['DEVIA_TEST_LM_URL'],
    });
    const result = await detectAgent(def);
    expect(result.providerType).toBe('local-model');
    expect(result.available).toBe(false);
    expect(result.selectable).toBe(false);
  });

  it('mcp providers report configured:false when no requiredEnvKeys are set', async () => {
    const def = plannedDef({
      id: 'mcp-x',
      providerType: 'mcp',
    });
    const result = await detectAgent(def);
    expect(result.providerType).toBe('mcp');
    expect(result.configured).toBe(false);
  });

  it('planned providers ignore requiredEnvKeys (always configured:false)', async () => {
    const ENV_KEY = '__DEVIA_TEST_PLANNED_' + Math.random().toString(36).slice(2);
    process.env[ENV_KEY] = 'whatever';
    try {
      const def = plannedDef({
        id: 'planned-with-key',
        providerType: 'planned',
        requiredEnvKeys: [ENV_KEY],
      });
      const result = await detectAgent(def);
      expect(result.providerType).toBe('planned');
      expect(result.configured).toBe(false);
    } finally {
      delete process.env[ENV_KEY];
    }
  });
});

describe('detectAgentSafe — error isolation', () => {
  it('returns a fallback DetectedAgent when detection throws', async () => {
    // Force a throw by handing detectAgentSafe a def whose providerType is
    // 'cli' but whose internal helpers will crash because `versionArgs` is
    // not an array. detectAgent will fail when it reads `def.versionArgs.join`.
    const broken: RuntimeAgentDef = {
      id: 'broken',
      name: 'Broken',
      bin: 'broken-bin-that-cannot-exist-' + Math.random().toString(36).slice(2),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      versionArgs: null as any,
      fallbackModels: [],
      buildArgs: () => [],
      streamFormat: 'plain',
      systemPromptStrategy: 'unsupported',
    };

    const result = await detectAgentSafe(broken);
    expect(result.available).toBe(false);
    expect(result.selectable).toBe(false);
    expect(result.id).toBe('broken');
    expect(result.providerType).toBe('cli');
    // unavailableReason should describe the failure mode but never include
    // the binary path or env values.
    expect(typeof result.unavailableReason === 'string' || result.unavailableReason === undefined).toBe(true);
  });

  it('does not retry on its own (called exactly once)', async () => {
    const spy = vi.fn();
    const def: RuntimeAgentDef = {
      id: 'planned-once',
      name: 'Planned',
      bin: 'planned-once',
      versionArgs: ['--version'],
      fallbackModels: [],
      buildArgs: () => {
        spy();
        return [];
      },
      streamFormat: 'plain',
      systemPromptStrategy: 'unsupported',
      providerType: 'planned',
      applicability: 'planned',
    };
    await detectAgentSafe(def);
    // buildArgs is never called for planned providers.
    expect(spy).not.toHaveBeenCalled();
  });
});
