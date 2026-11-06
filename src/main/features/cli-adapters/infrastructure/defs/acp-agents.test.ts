/**
 * Tests for the ACP agent defs (kimi, hermes): spawn args come from the ACP
 * profile (single source of truth), continuity and system-prompt strategy.
 */
import { describe, it, expect, vi } from 'vitest';
import { ACP_PROFILES } from '../../../agents/acp/profile';
import { AGENT_DEFS, warnUnsupportedSystemPromptStrategy } from '../registry';
import { kimiAgentDef } from './kimi';
import { hermesAgentDef } from './hermes';

describe('kimi def', () => {
  it('spawns `kimi acp` as an acp-json-rpc agent', () => {
    expect(kimiAgentDef.bin).toBe('kimi');
    expect(kimiAgentDef.buildArgs('p', [], [], {})).toEqual(['acp']);
    expect(kimiAgentDef.streamFormat).toBe('acp-json-rpc');
    expect(kimiAgentDef.providerType ?? 'cli').toBe('cli');
  });

  it('kimi def argv comes from its ACP profile', () => {
    expect(kimiAgentDef.buildArgs('p', [], [], {})).toEqual([...(ACP_PROFILES['kimi']?.args({ model: null }) ?? [])]);
  });
});

describe('hermes def', () => {
  it('spawns `hermes acp --accept-hooks` as an acp-json-rpc agent', () => {
    expect(hermesAgentDef.bin).toBe('hermes');
    expect(hermesAgentDef.buildArgs('p', [], [], {})).toEqual(['acp', '--accept-hooks']);
    expect(hermesAgentDef.streamFormat).toBe('acp-json-rpc');
  });

  it('hermes def argv comes from its ACP profile', () => {
    expect(hermesAgentDef.buildArgs('p', [], [], {})).toEqual([
      ...(ACP_PROFILES['hermes']?.args({ model: null }) ?? []),
    ]);
  });
});

describe('ACP defs match their profile', () => {
  it('their continuity matches the profile', () => {
    expect(kimiAgentDef.continuity).toBe(ACP_PROFILES['kimi']?.continuity);
    expect(hermesAgentDef.continuity).toBe(ACP_PROFILES['hermes']?.continuity);
  });

  it('systemPromptStrategy is stdin-prepend and the registry warns about neither agent', () => {
    expect(kimiAgentDef.systemPromptStrategy).toBe('stdin-prepend');
    expect(hermesAgentDef.systemPromptStrategy).toBe('stdin-prepend');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnUnsupportedSystemPromptStrategy(AGENT_DEFS.filter((d) => d.id === 'kimi' || d.id === 'hermes'));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
