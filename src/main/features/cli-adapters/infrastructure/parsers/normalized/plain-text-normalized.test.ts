import { describe, it, expect } from 'vitest';
import { createPlainTextNormalizedParser } from './plain-text-normalized';
import type { NormalizedEvent } from '../../../../../../shared/domain/normalized-event';

describe('createPlainTextNormalizedParser', () => {
  it('providerId matches constructor argument', () => {
    expect(createPlainTextNormalizedParser('qwen').providerId).toBe('qwen');
  });

  it('emits stream_start on first chunk with content', () => {
    const p = createPlainTextNormalizedParser('qwen');
    const events = p.feed('hello\n');
    expect(events.some((e) => e.kind === 'stream_start')).toBe(true);
  });

  it('emits text_delta for each line', () => {
    const p = createPlainTextNormalizedParser('qwen');
    const events = p.feed('line1\nline2\n');
    const deltas = events.filter((e) => e.kind === 'text_delta') as Extract<NormalizedEvent, { kind: 'text_delta' }>[];
    expect(deltas).toHaveLength(2);
    expect(deltas[0]?.text).toBe('line1');
    expect(deltas[1]?.text).toBe('line2');
  });

  it('accumulates partial lines across feeds', () => {
    const p = createPlainTextNormalizedParser('qwen');
    p.feed('hel');
    const events = p.feed('lo\n');
    const deltas = events.filter((e) => e.kind === 'text_delta') as Extract<NormalizedEvent, { kind: 'text_delta' }>[];
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.text).toBe('hello');
  });

  it('flush emits text_delta for trailing partial content', () => {
    const p = createPlainTextNormalizedParser('qwen');
    p.feed('partial');
    const flushed = p.flush();
    const delta = flushed.find((e) => e.kind === 'text_delta') as Extract<NormalizedEvent, { kind: 'text_delta' }>;
    expect(delta?.text).toBe('partial');
  });

  it('flush always emits stream_end', () => {
    const p = createPlainTextNormalizedParser('qwen');
    const flushed = p.flush();
    expect(flushed.some((e) => e.kind === 'stream_end')).toBe(true);
  });

  it('flush emits stream_start if nothing was fed', () => {
    const p = createPlainTextNormalizedParser('qwen');
    const flushed = p.flush();
    expect(flushed.some((e) => e.kind === 'stream_start')).toBe(true);
  });

  it('emits PARSER_OVERFLOW on huge chunk', () => {
    const p = createPlainTextNormalizedParser('qwen');
    const huge = 'x'.repeat(1_048_577);
    const events = p.feed(huge);
    const err = events.find((e) => e.kind === 'error') as Extract<NormalizedEvent, { kind: 'error' }>;
    expect(err?.code).toBe('PARSER_OVERFLOW');
  });

  // Property: chunk splits produce the same output
  it('same text_delta output regardless of chunk splits', () => {
    const full = 'hello\nworld\nfoo\n';
    const pA = createPlainTextNormalizedParser('qwen');
    const evA = pA.feed(full).filter((e) => e.kind === 'text_delta');

    const pB = createPlainTextNormalizedParser('qwen');
    const evB: NormalizedEvent[] = [];
    for (const ch of full) {
      evB.push(...pB.feed(ch).filter((e) => e.kind === 'text_delta'));
    }

    expect(evA).toEqual(evB);
  });
});
