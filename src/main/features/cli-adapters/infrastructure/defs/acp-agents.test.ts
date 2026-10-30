/**
 * Tests for the ACP agent defs (kimi, hermes): spawn args + acp-json-rpc format.
 */
import { describe, it, expect } from 'vitest';
import { kimiAgentDef } from './kimi';
import { hermesAgentDef } from './hermes';

describe('kimi def', () => {
  it('spawns `kimi acp` as an acp-json-rpc agent', () => {
    expect(kimiAgentDef.bin).toBe('kimi');
    expect(kimiAgentDef.buildArgs('p', [], [], {})).toEqual(['acp']);
    expect(kimiAgentDef.streamFormat).toBe('acp-json-rpc');
    expect(kimiAgentDef.providerType ?? 'cli').toBe('cli');
  });
});

describe('hermes def', () => {
  it('spawns `hermes acp --accept-hooks` as an acp-json-rpc agent', () => {
    expect(hermesAgentDef.bin).toBe('hermes');
    expect(hermesAgentDef.buildArgs('p', [], [], {})).toEqual(['acp', '--accept-hooks']);
    expect(hermesAgentDef.streamFormat).toBe('acp-json-rpc');
  });
});
