import { describe, it, expect, vi } from 'vitest';
import { HandoffSummariser, toBudgetMessages, HANDOFF_SUMMARY_TTL_MS } from './handoff-summariser';
import { AuxiliaryLLMError, type AuxiliaryLLMClient } from '../infrastructure/auxiliary-llm-client';

const MESSAGES = [
  { id: 'u1', role: 'user', text: 'implementa pagos' },
  { id: 'a1', role: 'assistant', text: 'voy' },
  { id: 'u2', role: 'user', text: 'añade tests' },
  { id: 'a2', role: 'assistant', text: 'hechos' },
  { id: 'u3', role: 'user', text: 'documenta' },
  { id: 'a3', role: 'assistant', text: 'listo' },
];

function okClient(summary = 'Resolved: pagos. Active: docs.'): AuxiliaryLLMClient {
  return { cliId: 'claude', summarise: vi.fn().mockResolvedValue(summary) };
}

function failingClient(): AuxiliaryLLMClient {
  return { cliId: 'claude', summarise: vi.fn().mockRejectedValue(new AuxiliaryLLMError('API down')) };
}

function build(client: AuxiliaryLLMClient, opts: { available?: boolean; now?: () => number } = {}) {
  return new HandoffSummariser({
    client: () => client,
    clientAvailable: () => opts.available ?? true,
    ...(opts.now !== undefined && { now: opts.now }),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('HandoffSummariser (S-2 F2.3)', () => {
  it('caches the compressed summary and consume() returns it once', async () => {
    const summariser = build(okClient());

    summariser.prepare('/p', 'sess-1', MESSAGES);
    await tick();

    expect(summariser.consume('/p', 'sess-1')).toBe('Resolved: pagos. Active: docs.');
    expect(summariser.consume('/p', 'sess-1')).toBeNull(); // one-shot
  });

  it('a failing auxiliary client yields a miss (deterministic brief stands)', async () => {
    const summariser = build(failingClient());

    summariser.prepare('/p', 'sess-1', MESSAGES);
    await tick();

    expect(summariser.consume('/p', 'sess-1')).toBeNull();
  });

  it('without a configured client it never even attempts the call', async () => {
    const client = okClient();
    const summariser = build(client, { available: false });

    summariser.prepare('/p', 'sess-1', MESSAGES);
    await tick();

    expect(client.summarise).not.toHaveBeenCalled();
    expect(summariser.consume('/p', 'sess-1')).toBeNull();
  });

  it('skips transcripts with nothing beyond the verbatim tail', async () => {
    const client = okClient();
    const summariser = build(client);

    summariser.prepare('/p', 'sess-1', MESSAGES.slice(0, 4));
    await tick();

    expect(client.summarise).not.toHaveBeenCalled();
  });

  it('a stale or mismatched entry is a miss', async () => {
    let now = 1_000;
    const summariser = build(okClient(), { now: () => now });

    summariser.prepare('/p', 'sess-1', MESSAGES);
    await tick();

    expect(summariser.consume('/p', 'otro-sess')).toBeNull();

    summariser.prepare('/p', 'sess-1', MESSAGES);
    await tick();
    now += HANDOFF_SUMMARY_TTL_MS + 1;
    expect(summariser.consume('/p', 'sess-1')).toBeNull();
  });
});

describe('toBudgetMessages', () => {
  it('keeps only user/assistant turns with text and drops handoff dividers', () => {
    const projected = toBudgetMessages([
      null,
      'garbage',
      { role: 'system', text: 'error' },
      { role: 'assistant', text: '' },
      { role: 'assistant', kind: 'handoff', text: '## Continuación…' },
      { role: 'user', text: 'hola' },
    ]);
    expect(projected).toEqual([{ role: 'user', content: 'hola' }]);
  });
});
