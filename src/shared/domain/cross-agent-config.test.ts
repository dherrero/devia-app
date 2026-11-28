import { describe, it, expect } from 'vitest';
import { DEFAULT_CROSS_AGENT_CONFIG, normalizeCrossAgentConfig } from './cross-agent-config';
import { DEFAULT_CONFIG } from './config';

describe('normalizeCrossAgentConfig', () => {
  it('is off by default with the planned limits', () => {
    expect(DEFAULT_CROSS_AGENT_CONFIG).toEqual({
      enabled: false,
      maxConcurrent: 3,
      maxPerTurn: 8,
      defaultTimeoutSec: 1800,
    });
    expect(DEFAULT_CONFIG.crossAgent).toEqual(DEFAULT_CROSS_AGENT_CONFIG);
  });

  it('returns the defaults for absent or non-object input', () => {
    expect(normalizeCrossAgentConfig(undefined)).toEqual(DEFAULT_CROSS_AGENT_CONFIG);
    expect(normalizeCrossAgentConfig(null)).toEqual(DEFAULT_CROSS_AGENT_CONFIG);
    expect(normalizeCrossAgentConfig('yes')).toEqual(DEFAULT_CROSS_AGENT_CONFIG);
  });

  it('keeps valid values and fills the rest from the defaults', () => {
    expect(normalizeCrossAgentConfig({ enabled: true, maxConcurrent: 2 })).toEqual({
      enabled: true,
      maxConcurrent: 2,
      maxPerTurn: 8,
      defaultTimeoutSec: 1800,
    });
  });

  it('replaces invalid numbers with the defaults', () => {
    const out = normalizeCrossAgentConfig({ maxConcurrent: 0, maxPerTurn: -1, defaultTimeoutSec: 'x' });
    expect(out).toEqual(DEFAULT_CROSS_AGENT_CONFIG);
  });

  it('floors fractional numbers and caps maxConcurrent at 8', () => {
    const out = normalizeCrossAgentConfig({ maxConcurrent: 99, maxPerTurn: 4.9, defaultTimeoutSec: 60.5 });
    expect(out.maxConcurrent).toBe(8);
    expect(out.maxPerTurn).toBe(4);
    expect(out.defaultTimeoutSec).toBe(60);
  });

  it('treats a non-boolean enabled as off', () => {
    expect(normalizeCrossAgentConfig({ enabled: 'true' }).enabled).toBe(false);
  });
});
