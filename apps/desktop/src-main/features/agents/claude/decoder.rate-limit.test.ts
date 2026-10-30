import { describe, it, expect } from 'vitest';
import { createClaudeStreamParser } from './decoder';
import type { AgentEvent } from '../../cli-adapters/domain/stream-parser';

function decode(...lines: object[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  const parser = createClaudeStreamParser((e) => events.push(e));
  for (const line of lines) parser.feed(JSON.stringify(line) + '\n');
  return events;
}

const rejected = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: 1792210200, rateLimitType: 'five_hour' },
};

describe('claude decoder — usage limit', () => {
  it('emits rate_limit with resetsAt converted to milliseconds when the limit is hit', () => {
    expect(decode(rejected)).toEqual([
      { type: 'rate_limit', status: 'rejected', resetsAt: 1792210200_000, rateLimitType: 'five_hour' },
    ]);
  });

  it('stays quiet on the steady "allowed" status every run reports', () => {
    expect(decode({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt: 1792210200, rateLimitType: 'five_hour' },
    })).toEqual([]);
  });

  it('reports a warning without a reset time when none is given', () => {
    expect(decode({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })).toEqual([
      { type: 'rate_limit', status: 'warning' },
    ]);
  });

  it('classifies the error result that follows a rejection as transient', () => {
    const events = decode(rejected, { type: 'result', is_error: true, result: "You've hit your limit" });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ classification: 'transient' });
  });

  // Shape recorded from real sessions (Claude Code 2.1.302, five-hour window).
  const limitMessage = {
    type: 'assistant',
    message: {
      model: '<synthetic>',
      content: [{ type: 'text', text: "You've hit your session limit · resets 11:30am (Europe/Madrid)" }],
    },
    apiError: 'usage_limit_reached',
    apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: 1792661400, rateLimitType: 'five_hour' } },
    error: 'rate_limit',
  };

  it('reads the limit from the synthetic assistant message', () => {
    const events = decode(limitMessage);
    expect(events.filter((e) => e.type === 'rate_limit')).toEqual([
      { type: 'rate_limit', status: 'rejected', resetsAt: 1792661400_000, rateLimitType: 'five_hour' },
    ]);
  });

  it('reports the same rejection once even when event, message and result all carry it', () => {
    const events = decode(rejected, limitMessage, { type: 'result', is_error: true, result: "You've hit your session limit" });
    expect(events.filter((e) => e.type === 'rate_limit')).toHaveLength(1);
  });

  it('falls back to the error result text and its reset time', () => {
    const events = decode({ type: 'result', is_error: true, result: "You've hit your session limit · resets 11:30am (Europe/Madrid)" });
    const limit = events.find((e) => e.type === 'rate_limit');
    expect(limit).toMatchObject({ type: 'rate_limit', status: 'rejected' });
    expect((limit as { resetsAt?: number }).resetsAt).toBeGreaterThan(Date.now());
  });

  it('keeps an error result without a rejection as unknown', () => {
    const events = decode({ type: 'result', is_error: true, result: 'boom' });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ classification: 'unknown' });
  });
});
