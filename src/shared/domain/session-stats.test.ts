import { describe, it, expect } from 'vitest';
import {
  parseSessionStats,
  aggregateSessionStats,
  buildSessionStats,
  type SessionStats,
  type StatsSourceMessage,
} from './session-stats';

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    agentId: 'claude',
    costUsd: 0,
    turnCount: 0,
    compactions: [],
    updatedAt: 1,
    ...overrides,
  };
}

describe('parseSessionStats (S-7)', () => {
  it('returns null for non-objects', () => {
    expect(parseSessionStats(null)).toBeNull();
    expect(parseSessionStats(42)).toBeNull();
    expect(parseSessionStats([])).toBeNull();
  });

  it('returns null when required fields are missing or mistyped', () => {
    expect(parseSessionStats({ costUsd: 1, turnCount: 1, updatedAt: 1 })).toBeNull(); // no agentId
    expect(parseSessionStats({ agentId: '', costUsd: 1, turnCount: 1, updatedAt: 1 })).toBeNull();
    expect(parseSessionStats({ agentId: 'claude', costUsd: '1', turnCount: 1, updatedAt: 1 })).toBeNull();
    expect(parseSessionStats({ agentId: 'claude', costUsd: 1, turnCount: 1 })).toBeNull(); // no updatedAt
  });

  it('parses a minimal valid rollup and defaults compactions to []', () => {
    const parsed = parseSessionStats({ agentId: 'claude', costUsd: 0, turnCount: 0, updatedAt: 5 });
    expect(parsed).toEqual({
      agentId: 'claude',
      costUsd: 0,
      turnCount: 0,
      compactions: [],
      updatedAt: 5,
    });
  });

  it('keeps optional numeric/string fields when present', () => {
    const parsed = parseSessionStats({
      agentId: 'claude',
      model: 'claude-opus-4-8',
      contextWindow: 1_000_000,
      contextTokens: 12_345,
      costUsd: 0.42,
      turnCount: 3,
      updatedAt: 9,
    });
    expect(parsed?.model).toBe('claude-opus-4-8');
    expect(parsed?.contextWindow).toBe(1_000_000);
    expect(parsed?.contextTokens).toBe(12_345);
  });

  it('drops malformed compaction entries but keeps valid ones', () => {
    const parsed = parseSessionStats({
      agentId: 'claude',
      costUsd: 0,
      turnCount: 0,
      updatedAt: 1,
      compactions: [
        { at: 100, trigger: 'auto', preTokens: 900, postTokens: 300 },
        { trigger: 'auto' }, // no `at` → dropped
        { at: 200, trigger: 'nonsense' }, // bad trigger ignored, record kept
      ],
    });
    expect(parsed?.compactions).toEqual([
      { at: 100, trigger: 'auto', preTokens: 900, postTokens: 300 },
      { at: 200 },
    ]);
  });

  it('keeps only numeric entries of costByModel', () => {
    const parsed = parseSessionStats({
      agentId: 'claude',
      costUsd: 1,
      turnCount: 1,
      updatedAt: 1,
      costByModel: { 'claude-opus-4-8': 0.8, 'gpt-5': 'x' },
    });
    expect(parsed?.costByModel).toEqual({ 'claude-opus-4-8': 0.8 });
  });
});

describe('aggregateSessionStats (S-7)', () => {
  it('returns zeroes for an empty list', () => {
    expect(aggregateSessionStats([])).toEqual({
      grandTotalCostUsd: 0,
      byModel: {},
      sessionCount: 0,
    });
  });

  it('sums costs and attributes them to each session model', () => {
    const agg = aggregateSessionStats([
      makeStats({ model: 'claude-opus-4-8', costUsd: 0.5 }),
      makeStats({ model: 'claude-opus-4-8', costUsd: 0.25 }),
      makeStats({ model: 'gpt-5', costUsd: 0.1 }),
    ]);
    expect(agg.grandTotalCostUsd).toBe(0.85);
    expect(agg.byModel).toEqual({ 'claude-opus-4-8': 0.75, 'gpt-5': 0.1 });
    expect(agg.sessionCount).toBe(3);
  });

  it('credits cost to "unknown" when the model is absent', () => {
    const agg = aggregateSessionStats([makeStats({ costUsd: 0.3 })]);
    expect(agg.byModel).toEqual({ unknown: 0.3 });
  });

  it('prefers per-session costByModel over the flat model attribution', () => {
    const agg = aggregateSessionStats([
      makeStats({
        model: 'claude-opus-4-8',
        costUsd: 1.0,
        costByModel: { 'claude-opus-4-8': 0.7, 'claude-haiku-4-5': 0.3 },
      }),
    ]);
    expect(agg.grandTotalCostUsd).toBe(1.0);
    expect(agg.byModel).toEqual({ 'claude-opus-4-8': 0.7, 'claude-haiku-4-5': 0.3 });
  });

  it('rounds away floating-point noise', () => {
    const agg = aggregateSessionStats([
      makeStats({ model: 'm', costUsd: 0.1 }),
      makeStats({ model: 'm', costUsd: 0.2 }),
    ]);
    expect(agg.grandTotalCostUsd).toBe(0.3);
    expect(agg.byModel['m']).toBe(0.3);
  });
});

describe('buildSessionStats (S-7)', () => {
  const msgs: StatsSourceMessage[] = [
    { role: 'user' },
    { role: 'assistant', agentId: 'claude', model: 'claude-opus-4-8',
      usage: { inputTokens: 10_000, cachedInputTokens: 2_000, costUsd: 0.1, contextWindow: 1_000_000 } },
    { role: 'user' },
    { role: 'assistant', agentId: 'claude', model: 'claude-opus-4-8',
      usage: { inputTokens: 30_000, cachedInputTokens: 5_000, costUsd: 0.2, contextWindow: 1_000_000 } },
  ];

  it('sums cost, takes the last turn for context, counts turns', () => {
    const s = buildSessionStats({ messages: msgs, fallbackAgentId: 'x', now: 42 });
    expect(s.costUsd).toBe(0.3);
    expect(s.contextTokens).toBe(35_000); // last turn: 30k + 5k
    expect(s.contextWindow).toBe(1_000_000);
    expect(s.turnCount).toBe(2);
    expect(s.agentId).toBe('claude');
    expect(s.model).toBe('claude-opus-4-8');
    expect(s.costByModel).toEqual({ 'claude-opus-4-8': 0.3 });
    expect(s.updatedAt).toBe(42);
  });

  it('falls back to provided agent/model/window when no turn reported them', () => {
    const s = buildSessionStats({
      messages: [{ role: 'assistant' }],
      fallbackAgentId: 'gemini',
      fallbackModel: 'gemini-2.5-pro',
      fallbackContextWindow: 1_048_576,
      now: 1,
    });
    expect(s.agentId).toBe('gemini');
    expect(s.model).toBe('gemini-2.5-pro');
    expect(s.contextWindow).toBe(1_048_576);
    expect(s.contextTokens).toBeUndefined();
    expect(s.costUsd).toBe(0);
    expect(s.costByModel).toBeUndefined();
  });

  it('carries prior compactions forward', () => {
    const s = buildSessionStats({
      messages: msgs,
      fallbackAgentId: 'x',
      priorCompactions: [{ at: 5, trigger: 'auto', preTokens: 900 }],
      now: 1,
    });
    expect(s.compactions).toEqual([{ at: 5, trigger: 'auto', preTokens: 900 }]);
  });

  it('attributes cost per model when the session switched models', () => {
    const s = buildSessionStats({
      messages: [
        { role: 'assistant', model: 'claude-opus-4-8', usage: { costUsd: 0.4 } },
        { role: 'assistant', model: 'claude-haiku-4-5', usage: { costUsd: 0.1 } },
      ],
      fallbackAgentId: 'claude',
      now: 1,
    });
    expect(s.costByModel).toEqual({ 'claude-opus-4-8': 0.4, 'claude-haiku-4-5': 0.1 });
    expect(s.model).toBe('claude-haiku-4-5'); // last turn
  });
});
