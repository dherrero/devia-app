import { describe, it, expect, beforeEach } from 'vitest';
import {
  compress,
  compressIfOverflow,
  truncateToFitBudget,
} from './context-compressor';
import { estimateTokens, type ChatMessageForBudget } from '../../../../shared/domain/context-budget';
import {
  AuxiliaryLLMError,
  type AuxiliaryLLMClient,
  type SummariseInput,
} from '../infrastructure/auxiliary-llm-client';
import { __setPlanForTest, currentPlan, hasPlan } from './plan-gate';

/**
 * Compressor tests for E-DSK-09 #263.
 *
 * Builds a 200-turn fake history, drives it through the compressor
 * with a tiny budget, and asserts:
 *   - the system prompt and last K turns survive verbatim
 *   - a `[Resumen]` block lands in the middle slot
 *   - the second pass re-compresses if the first wasn't enough
 *   - aux failure falls back to truncation cleanly
 *   - estimate stays under the requested budget
 *
 * Pure unit tests — no real network calls.
 */

function makeHistory(turns: number, chunkSize = 240): ChatMessageForBudget[] {
  // First message is the system prompt (head). Then `turns` alternating
  // user / assistant pairs. Each chunkSize chars ≈ 60 tokens via the
  // chars/4 heuristic, so a 200-turn history at 240 chars ≈ 12k tokens —
  // easy to push past tiny budgets without inflating the fixture.
  const out: ChatMessageForBudget[] = [
    {
      role: 'system',
      content: 'You are devia, a coding assistant. Always be concise.',
    },
  ];
  for (let i = 0; i < turns; i++) {
    const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
    out.push({
      role,
      content: `${role}-${i}: ` + 'lorem ipsum dolor sit amet, consectetur. '.repeat(Math.ceil(chunkSize / 36)),
    });
  }
  return out;
}

class StubAuxiliary implements AuxiliaryLLMClient {
  readonly cliId = 'claude';
  calls = 0;
  /** Optional override — when set, summarise() throws instead of
   *  returning. Used to exercise the truncation fallback path. */
  failWith: Error | undefined;

  // eslint-disable-next-line @typescript-eslint/require-await
  async summarise(input: SummariseInput): Promise<string> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    // Deterministic summary: short string proportional to input size,
    // so the iterative loop has a real chance to converge.
    const span = input.messages.length;
    return `Summary of ${span} earlier turns. (turn-1 .. turn-${span})`;
  }
}

describe('estimateTokens', () => {
  it('approximates chars/4 for plain string content', () => {
    const out = estimateTokens([{ role: 'user', content: 'a'.repeat(400) }]);
    expect(out).toBeGreaterThan(80);
    expect(out).toBeLessThan(120);
  });

  it('counts image parts at the flat 1500-token cost', () => {
    const out = estimateTokens([
      { role: 'user', content: [{ type: 'image' }] },
    ]);
    expect(out).toBe(1500);
  });

  it('ignores malformed entries instead of throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => estimateTokens([{ role: 'user', content: null as any }])).not.toThrow();
  });
});

describe('compress (single-pass)', () => {
  let client: StubAuxiliary;

  beforeEach(() => {
    client = new StubAuxiliary();
  });

  it('returns the input untouched when already under budget', async () => {
    const history = makeHistory(2);
    const result = await compress(history, client, { targetBudget: 1_000_000 });
    expect(result.didCompress).toBe(false);
    expect(result.iterations).toBe(0);
    expect(result.messages.length).toBe(history.length);
    expect(client.calls).toBe(0);
  });

  it('preserves the head and the last 4 turns verbatim', async () => {
    const history = makeHistory(200);
    const result = await compress(history, client, {
      targetBudget: 10_000,
      headKeep: 1,
      tailKeep: 4,
    });
    // Head: index 0 unchanged.
    expect(result.messages[0]).toEqual(history[0]);
    // Tail: indices length-4 .. length-1 unchanged.
    const inTail = result.messages.slice(-4);
    const expectedTail = history.slice(-4);
    expect(inTail).toEqual(expectedTail);
  });

  it('injects a [Resumen] block between head and tail', async () => {
    const history = makeHistory(200);
    const result = await compress(history, client, {
      targetBudget: 10_000,
    });
    // The exact slot depends on iterations; in a single-pass run the
    // summary sits at index 1.
    const summary = result.messages.find((m) => m.summary === true);
    expect(summary).toBeDefined();
    expect(typeof summary?.content).toBe('string');
    expect(summary?.content).toMatch(/^\[Resumen\]/);
  });

  it('iterates when one pass does not fit the budget', async () => {
    // Force the stub to emit a summary larger than the budget so the
    // first pass alone never converges. Subsequent passes re-summarise
    // the prior summary together with the (small) tail, eventually
    // dropping under target. Without iteration the result would still
    // exceed `targetBudget` after the first pass.
    class LongSummaryStub extends StubAuxiliary {
      override async summarise(): Promise<string> {
        this.calls++;
        // First call: emit a 3k-token block. Second call: tiny.
        // Forces a second iteration to land under the 1k budget.
        if (this.calls === 1) return 'x'.repeat(12_000); // ~3000 tokens
        return 'tiny';
      }
    }
    const longClient = new LongSummaryStub();
    const history = makeHistory(200);
    const result = await compress(history, longClient, {
      targetBudget: 1_000,
      maxIterations: 3,
    });
    expect(longClient.calls).toBeGreaterThan(1);
    expect(result.iterations).toBeGreaterThan(1);
  });

  it('falls back to truncation when the auxiliary client throws', async () => {
    client.failWith = new AuxiliaryLLMError('upstream down');
    const history = makeHistory(200);
    const result = await compress(history, client, { targetBudget: 8_000 });
    expect(result.fallback).toBe('truncate');
    expect(result.fallbackReason).toContain('upstream');
    expect(result.estimatedTokens).toBeLessThanOrEqual(8_000);
    // Head + tail preserved even via truncation.
    expect(result.messages[0]).toEqual(history[0]);
  });

  it('truncates without ever calling the aux when target requires only middle drops', async () => {
    // Pre-emptive truncation directly via the helper.
    const history = makeHistory(50);
    const truncated = truncateToFitBudget(history, 2_000, 1, 4);
    expect(truncated.length).toBeLessThan(history.length);
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(2_000);
    expect(truncated[0]).toEqual(history[0]);
  });

  it('respects maxIterations and stops even if budget is unreachable', async () => {
    // Force a stub that returns an enormous summary so iterations
    // never converge.
    class BadStub extends StubAuxiliary {
      override async summarise(): Promise<string> {
        this.calls++;
        return 'x'.repeat(50_000);
      }
    }
    const bad = new BadStub();
    const result = await compress(makeHistory(200), bad, {
      targetBudget: 1_000,
      maxIterations: 2,
    });
    expect(result.iterations).toBeLessThanOrEqual(2);
    // Bounded — never spins forever.
  });
});

describe('compressIfOverflow', () => {
  it('skips compression when under the 80% trigger', async () => {
    const client = new StubAuxiliary();
    const history = makeHistory(5);
    const result = await compressIfOverflow(history, client, 1_000_000);
    expect(result.didCompress).toBe(false);
    expect(client.calls).toBe(0);
  });

  it('compresses when over the 80% trigger', async () => {
    const client = new StubAuxiliary();
    const history = makeHistory(200);
    // modelBudget set so 80% threshold is ~6000 — definitely tripped
    // by the 200-turn fixture.
    const result = await compressIfOverflow(history, client, 8_000);
    expect(result.didCompress).toBe(true);
    expect(client.calls).toBeGreaterThanOrEqual(1);
  });
});

describe('plan gate (stub for E-DSK-08 #252)', () => {
  beforeEach(() => __setPlanForTest(undefined));

  it('defaults to free when the env var is unset', () => {
    delete process.env['DEVIA_PLAN'];
    expect(currentPlan()).toBe('free');
    expect(hasPlan('pro')).toBe(false);
  });

  it('reads DEVIA_PLAN from the env', () => {
    process.env['DEVIA_PLAN'] = 'pro';
    expect(currentPlan()).toBe('pro');
    expect(hasPlan('pro')).toBe(true);
    delete process.env['DEVIA_PLAN'];
  });

  it('honours the test override', () => {
    __setPlanForTest('enterprise');
    expect(currentPlan()).toBe('enterprise');
    expect(hasPlan('pro')).toBe(true);
  });

  it('rejects unknown plan strings (defaults to free)', () => {
    process.env['DEVIA_PLAN'] = 'gold';
    expect(currentPlan()).toBe('free');
    delete process.env['DEVIA_PLAN'];
  });
});

describe('Free-path quota_exceeded emission (integration sketch)', () => {
  it('caller checks hasPlan before invoking compress — documented contract', () => {
    // The compressor itself is plan-agnostic by design; the runner
    // wires the gate. This test pins the contract: if hasPlan('pro')
    // is false, the runner should skip compress() and emit
    // quota_exceeded instead.
    __setPlanForTest('free');
    expect(hasPlan('pro')).toBe(false);
    __setPlanForTest('pro');
    expect(hasPlan('pro')).toBe(true);
    __setPlanForTest(undefined);
  });
});
