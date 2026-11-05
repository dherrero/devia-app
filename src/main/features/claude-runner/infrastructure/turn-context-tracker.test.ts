import { describe, it, expect } from 'vitest';
import { TurnContextTracker } from './turn-context-tracker';

describe('TurnContextTracker', () => {
  it('always sends on the first turn', () => {
    const t = new TurnContextTracker();
    t.markDelivered('s1', 'h1');
    expect(t.shouldSend({ resumeSessionId: undefined, hash: 'h1' })).toBe(true);
  });

  it('sends when nothing was delivered for the session', () => {
    expect(new TurnContextTracker().shouldSend({ resumeSessionId: 's1', hash: 'h1' })).toBe(true);
  });

  it('skips an unchanged block', () => {
    const t = new TurnContextTracker();
    t.markDelivered('s1', 'h1');
    expect(t.shouldSend({ resumeSessionId: 's1', hash: 'h1' })).toBe(false);
  });

  it('sends again when the hash changes', () => {
    const t = new TurnContextTracker();
    t.markDelivered('s1', 'h1');
    expect(t.shouldSend({ resumeSessionId: 's1', hash: 'h2' })).toBe(true);
  });

  it('force overrides the dedupe', () => {
    const t = new TurnContextTracker();
    t.markDelivered('s1', 'h1');
    expect(t.shouldSend({ resumeSessionId: 's1', hash: 'h1', force: true })).toBe(true);
  });

  it('invalidate makes the next turn resend', () => {
    const t = new TurnContextTracker();
    t.markDelivered('s1', 'h1');
    expect(t.shouldSend({ resumeSessionId: 's1', hash: 'h1' })).toBe(false);
    t.invalidate('s1');
    expect(t.shouldSend({ resumeSessionId: 's1', hash: 'h1' })).toBe(true);
  });

  it('sessions are independent', () => {
    const t = new TurnContextTracker();
    t.markDelivered('s1', 'h1');
    expect(t.shouldSend({ resumeSessionId: 's2', hash: 'h1' })).toBe(true);
    expect(t.shouldSend({ resumeSessionId: 's1', hash: 'h1' })).toBe(false);
  });

  it('is bounded: the oldest session is forgotten and resent', () => {
    const t = new TurnContextTracker();
    for (let i = 0; i < 300; i++) t.markDelivered(`s${i}`, 'h');
    expect(t.shouldSend({ resumeSessionId: 's0', hash: 'h' })).toBe(true);
    expect(t.shouldSend({ resumeSessionId: 's299', hash: 'h' })).toBe(false);
  });
});
