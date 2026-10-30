import { describe, expect, it } from 'vitest';
import { isLimitText, parseResetFromText } from './limit-text';

describe('limit text', () => {
  it('recognises the session-limit message', () => {
    expect(isLimitText("You've hit your session limit · resets 11:30am (Europe/Madrid)")).toBe(true);
    expect(isLimitText('You have hit your weekly limit')).toBe(true);
    expect(isLimitText('all good')).toBe(false);
  });

  it('reads the reset time in the named zone (CEST, UTC+2)', () => {
    const now = Date.UTC(2026, 9, 22, 6, 0); // 08:00 in Madrid
    expect(parseResetFromText('hit your session limit · resets 11:30am (Europe/Madrid)', now))
      .toBe(Date.UTC(2026, 9, 22, 9, 30));
  });

  it('rolls over to tomorrow when the time already passed today', () => {
    const now = Date.UTC(2026, 9, 22, 12, 0); // 14:00 in Madrid
    expect(parseResetFromText('resets 1:10am (Europe/Madrid)', now)).toBe(Date.UTC(2026, 9, 22, 23, 10));
  });

  it('handles pm and minutes-less times', () => {
    const now = Date.UTC(2026, 9, 22, 6, 0);
    expect(parseResetFromText('resets 4pm (Europe/Madrid)', now)).toBe(Date.UTC(2026, 9, 22, 14, 0));
  });

  it('reads a dated reset (weekly window)', () => {
    const now = Date.UTC(2026, 9, 27, 6, 0);
    expect(parseResetFromText("You've hit your weekly limit · resets Oct 30, 3pm (Europe/Madrid)", now))
      .toBe(Date.UTC(2026, 9, 30, 14, 0));
    expect(parseResetFromText('resets Nov 2 at 10:15am (Europe/Madrid)', now))
      .toBe(Date.UTC(2026, 10, 2, 9, 15));
  });

  it('reads the weekly message exactly as Claude Code 2.1.x writes it', () => {
    // Recorded: resetsAt 1793084400 for this text.
    const now = Date.UTC(2026, 9, 24, 8, 0);
    expect(parseResetFromText("You've hit your weekly limit · resets Oct 27 at 8am (Europe/Madrid)", now))
      .toBe(1793084400_000);
  });

  it('returns undefined without a parsable time or with a bad zone', () => {
    expect(parseResetFromText('nothing here', 0)).toBeUndefined();
    expect(parseResetFromText('resets 4pm (Mars/Olympus)', 0)).toBeUndefined();
  });
});
