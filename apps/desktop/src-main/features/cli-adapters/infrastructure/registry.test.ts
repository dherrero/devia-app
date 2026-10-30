import { describe, it, expect, vi } from 'vitest';
import {
  StaticCliAdapterRegistry,
  AGENT_DEFS,
  assertNoDuplicateIds,
  warnUnsupportedSystemPromptStrategy,
} from './registry';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';

/** Minimal stub for a RuntimeAgentDef. */
function makeDef(id: string, overrides: Partial<RuntimeAgentDef> = {}): RuntimeAgentDef {
  return {
    id,
    name: `Agent ${id}`,
    bin: id,
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => [],
    streamFormat: 'plain',
    systemPromptStrategy: 'unsupported',
    ...overrides,
  };
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('assertNoDuplicateIds', () => {
  it('does not throw for unique ids', () => {
    const defs = [makeDef('alpha'), makeDef('beta'), makeDef('gamma')];
    expect(() => assertNoDuplicateIds(defs)).not.toThrow();
  });

  it('throws for duplicate ids', () => {
    const defs = [makeDef('dupe'), makeDef('unique'), makeDef('dupe')];
    expect(() => assertNoDuplicateIds(defs)).toThrowError(
      'Duplicate agent definition id: dupe',
    );
  });

  it('throws immediately on first duplicate found', () => {
    const defs = [makeDef('a'), makeDef('a'), makeDef('b')];
    expect(() => assertNoDuplicateIds(defs)).toThrowError(
      'Duplicate agent definition id: a',
    );
  });

  it('does not throw for empty array', () => {
    expect(() => assertNoDuplicateIds([])).not.toThrow();
  });
});

describe('AGENT_DEFS (module-level invariant)', () => {
  it('contains the tier-1 fully integrated CLI agents', () => {
    const ids = AGENT_DEFS.map((d) => d.id);
    for (const id of ['claude', 'codex', 'gemini', 'opencode', 'cursor-agent', 'copilot']) {
      expect(ids).toContain(id);
    }
  });

  it('contains the tier-2 adapted CLI agents (plain-text streaming)', () => {
    const ids = AGENT_DEFS.map((d) => d.id);
    expect(ids).toContain('qwen');
    expect(ids).toContain('deepseek');
    expect(ids).toContain('qoder');
  });

  it('no longer ships the removed planned providers (api / local-model / acp)', () => {
    const ids = AGENT_DEFS.map((d) => d.id);
    const removed = [
      'anthropic-api', 'openai-api', 'google-api', 'ollama',
      'devin', 'kiro', 'kilo', 'vibe',
    ];
    for (const id of removed) {
      expect(ids).not.toContain(id);
    }
  });

  it('every built-in agent is an executable cli provider', () => {
    for (const def of AGENT_DEFS) {
      const providerType = def.providerType ?? 'cli';
      expect(providerType, `${def.id} should be cli`).toBe('cli');
    }
  });

  it('tier-1 + tier-2 CLI agents leave providerType cli or undefined', () => {
    const cliIds = ['claude', 'codex', 'gemini', 'opencode', 'cursor-agent', 'copilot', 'qwen', 'deepseek', 'qoder'];
    for (const id of cliIds) {
      const def = AGENT_DEFS.find((d) => d.id === id);
      const providerType = def?.providerType ?? 'cli';
      expect(providerType, `${id} should be cli`).toBe('cli');
    }
  });

  it('has no duplicate ids in the built-in catalog', () => {
    expect(() => assertNoDuplicateIds(AGENT_DEFS)).not.toThrow();
  });

  // UC-FIX-018: every built-in def must declare the required field.
  it('every built-in def has systemPromptStrategy set', () => {
    for (const def of AGENT_DEFS) {
      expect(
        def.systemPromptStrategy,
        `${def.id} is missing systemPromptStrategy`,
      ).toBeDefined();
    }
  });
});

describe('warnUnsupportedSystemPromptStrategy', () => {
  it('emits a warning for CLI defs with unsupported strategy', () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defs = [
      makeDef('plain-cli', { providerType: 'cli', systemPromptStrategy: 'unsupported' }),
    ];
    warnUnsupportedSystemPromptStrategy(defs);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('plain-cli'));
    warnSpy.mockRestore();
  });

  it('does NOT warn for non-CLI providers with unsupported strategy', () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defs = [
      makeDef('api-prov', { providerType: 'api', systemPromptStrategy: 'unsupported' }),
    ];
    warnUnsupportedSystemPromptStrategy(defs);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does NOT warn for CLI defs with argv or stdin-prepend strategy', () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnUnsupportedSystemPromptStrategy([
      makeDef('a', { systemPromptStrategy: 'argv' }),
      makeDef('b', { systemPromptStrategy: 'stdin-prepend' }),
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('StaticCliAdapterRegistry', () => {
  it('all() returns all built-in defs', () => {
    const registry = new StaticCliAdapterRegistry();
    const all = registry.all();
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.map((d) => d.id)).toContain('claude');
  });

  it('get() returns the correct def for a known id', () => {
    const registry = new StaticCliAdapterRegistry();
    const def = expectPresent(registry.get('claude'));
    expect(def.id).toBe('claude');
    expect(def.name).toBe('Claude Code');
  });

  it('get() returns null for an unknown id', () => {
    const registry = new StaticCliAdapterRegistry();
    expect(registry.get('nonexistent-agent-xyz')).toBeNull();
  });

  it('registerAdditional adds new defs accessible via get()', () => {
    const registry = new StaticCliAdapterRegistry();
    const customDef = makeDef('custom-agent', { bin: 'custom-agent' });
    registry.registerAdditional([customDef]);
    const retrieved = expectPresent(registry.get('custom-agent'));
    expect(retrieved.id).toBe('custom-agent');
  });

  it('registerAdditional silently skips defs with duplicate ids (no throw)', () => {
    const registry = new StaticCliAdapterRegistry();
    // 'claude' already exists in AGENT_DEFS
    const dupeDef = makeDef('claude', { bin: 'claude', name: 'Duplicate Claude' });
    expect(() => registry.registerAdditional([dupeDef])).not.toThrow();
    // Original def should still be returned
    expect(expectPresent(registry.get('claude')).name).toBe('Claude Code');
  });

  it('registerAdditional silently skips defs missing bin', () => {
    const registry = new StaticCliAdapterRegistry();
    const noBinDef = { ...makeDef('no-bin-agent'), bin: '' };
    expect(() => registry.registerAdditional([noBinDef])).not.toThrow();
    expect(registry.get('no-bin-agent')).toBeNull();
  });

  describe('installMetaForAgent', () => {
    it('returns installUrl and docsUrl for claude', () => {
      const registry = new StaticCliAdapterRegistry();
      const meta = registry.installMetaForAgent('claude');
      expect(meta.installUrl).toBeDefined();
      expect(typeof meta.installUrl).toBe('string');
    });

    it('returns installUrl for codex', () => {
      const registry = new StaticCliAdapterRegistry();
      const meta = registry.installMetaForAgent('codex');
      expect(meta.installUrl).toBeDefined();
    });

    it('returns empty object for unknown agent id', () => {
      const registry = new StaticCliAdapterRegistry();
      const meta = registry.installMetaForAgent('nonexistent');
      expect(meta).toEqual({});
    });
  });
});
