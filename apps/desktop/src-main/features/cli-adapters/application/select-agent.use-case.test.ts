/**
 * REV-AGENT-CORE-014: SelectAgentUseCase rejects non-executable providers.
 *
 * The renderer can request any id, but the main process is the source of
 * truth for what counts as a usable CLI. These tests assert:
 *   - cli-type defs are accepted and persisted
 *   - non-cli defs are rejected with a reason; persisted id stays unchanged
 *   - unknown ids are rejected with a reason; persisted id stays unchanged
 */
import { describe, it, expect } from 'vitest';
import { SelectAgentUseCase } from './select-agent.use-case';
import type { CliAdapterRegistry } from '../domain/ports';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';
import type { ConfigRepository } from '../../../shared/ports';
import type { DeviaConfig } from '../../../../shared/domain/config';

function fakeDef(overrides: Partial<RuntimeAgentDef> & { id: string }): RuntimeAgentDef {
  return {
    name: overrides.id,
    bin: overrides.id,
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => [],
    streamFormat: 'plain',
    systemPromptStrategy: 'unsupported',
    ...overrides,
  };
}

function fakeRegistry(defs: RuntimeAgentDef[]): CliAdapterRegistry {
  return {
    all: () => defs,
    get: (id: string) => defs.find((d) => d.id === id) ?? null,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    registerAdditional: () => {},
    installMetaForAgent: () => ({}),
  };
}

function fakeConfig(initial: Partial<DeviaConfig>): ConfigRepository {
  let state = {
    workspaceRoot: '',
    ignoreFolders: [],
    agentId: 'claude',
    agentModels: {},
    agentCliEnv: {},
    agentToolPolicy: {},
    ...initial,
  } as DeviaConfig;
  return {
    get: () => state,
    set: (patch: Partial<DeviaConfig>) => {
      state = { ...state, ...patch };
    },
    deviaDir: () => '/tmp/devia',
    configPath: () => '/tmp/devia/config.json',
  } as unknown as ConfigRepository;
}

describe('SelectAgentUseCase', () => {
  it('accepts a CLI provider and persists the id', () => {
    const registry = fakeRegistry([
      fakeDef({ id: 'claude', providerType: 'cli' }),
      fakeDef({ id: 'codex', providerType: 'cli' }),
    ]);
    const config = fakeConfig({ agentId: 'claude' });

    const useCase = new SelectAgentUseCase(registry, config);
    const result = useCase.execute({ agentId: 'codex' });

    expect(result.accepted).toBe(true);
    expect(result.agentId).toBe('codex');
    expect(config.get().agentId).toBe('codex');
    expect(result.rejectedReason).toBeUndefined();
  });

  it('accepts a CLI provider when providerType is omitted (back-compat default)', () => {
    const registry = fakeRegistry([
      fakeDef({ id: 'claude' /* no providerType — treated as cli */ }),
    ]);
    const config = fakeConfig({ agentId: 'codex' });

    const useCase = new SelectAgentUseCase(registry, config);
    const result = useCase.execute({ agentId: 'claude' });

    expect(result.accepted).toBe(true);
    expect(config.get().agentId).toBe('claude');
  });

  it('rejects a planned provider and keeps the current id', () => {
    const registry = fakeRegistry([
      fakeDef({ id: 'claude', providerType: 'cli' }),
      fakeDef({ id: 'devin', providerType: 'planned', unavailableReason: 'ACP planned.' }),
    ]);
    const config = fakeConfig({ agentId: 'claude' });

    const useCase = new SelectAgentUseCase(registry, config);
    const result = useCase.execute({ agentId: 'devin' });

    expect(result.accepted).toBe(false);
    expect(result.agentId).toBe('claude');
    expect(config.get().agentId).toBe('claude');
    expect(result.rejectedReason).toBe('ACP planned.');
  });

  it('rejects an api provider and keeps the current id', () => {
    const registry = fakeRegistry([
      fakeDef({ id: 'claude', providerType: 'cli' }),
      fakeDef({ id: 'anthropic-api', providerType: 'api' }),
    ]);
    const config = fakeConfig({ agentId: 'claude' });

    const useCase = new SelectAgentUseCase(registry, config);
    const result = useCase.execute({ agentId: 'anthropic-api' });

    expect(result.accepted).toBe(false);
    expect(config.get().agentId).toBe('claude');
    expect(result.rejectedReason).toContain('api');
  });

  it('rejects an unknown id with a reason and leaves config untouched', () => {
    const registry = fakeRegistry([fakeDef({ id: 'claude', providerType: 'cli' })]);
    const config = fakeConfig({ agentId: 'claude' });

    const useCase = new SelectAgentUseCase(registry, config);
    const result = useCase.execute({ agentId: 'totally-unknown' });

    expect(result.accepted).toBe(false);
    expect(result.agentId).toBe('claude');
    expect(result.rejectedReason).toMatch(/Unknown agent id/);
  });

  it('rejects an mcp provider without falling through to acceptance', () => {
    const registry = fakeRegistry([
      fakeDef({ id: 'mcp-x', providerType: 'mcp' }),
    ]);
    const config = fakeConfig({ agentId: 'claude' });

    const useCase = new SelectAgentUseCase(registry, config);
    const result = useCase.execute({ agentId: 'mcp-x' });

    expect(result.accepted).toBe(false);
    expect(config.get().agentId).toBe('claude');
  });
});
