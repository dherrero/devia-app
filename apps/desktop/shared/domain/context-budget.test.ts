import { describe, it, expect } from 'vitest';
import { contextAlertBand, COMPRESS_RATIO, replayBudgetChars } from './context-budget';

describe('replayBudgetChars (S-19 F0)', () => {
  it('scales with the model window, clamped to 1500–8000 tokens (×4 chars)', () => {
    // gemini 1M window → 10% = 100k tokens, clamped to 8000 → 32000 chars.
    expect(replayBudgetChars('gemini', 'gemini-2.5-pro')).toBe(8_000 * 4);
    // opencode default 128k → 10% = 12800, clamped to 8000 → 32000 chars.
    expect(replayBudgetChars('opencode')).toBe(8_000 * 4);
  });

  it('floors an unknown CLI at the minimum-window slice (1500 tokens)', () => {
    // Unknown → MINIMUM_CONTEXT_LENGTH 64k → 10% = 6400 tokens → 25600 chars.
    expect(replayBudgetChars('totally-unknown-cli')).toBe(6_400 * 4);
  });

  it('is always more generous than the memory hint budget', () => {
    expect(replayBudgetChars('opencode')).toBeGreaterThan(1_500 * 4);
  });
});

describe('contextAlertBand (S-1 T-5)', () => {
  it('returns "enter" exactly at COMPRESS_RATIO', () => {
    expect(contextAlertBand(COMPRESS_RATIO)).toBe('enter');
  });

  it('returns "enter" above the warn threshold', () => {
    expect(contextAlertBand(0.92)).toBe('enter');
    expect(contextAlertBand(1.0)).toBe('enter');
  });

  it('returns "exit" only below the re-arm floor (default 0.7)', () => {
    expect(contextAlertBand(0.69)).toBe('exit');
    expect(contextAlertBand(0.0)).toBe('exit');
  });

  it('returns "hold" inside the hysteresis dead-band [0.7, 0.8)', () => {
    expect(contextAlertBand(0.7)).toBe('hold');
    expect(contextAlertBand(0.75)).toBe('hold');
    expect(contextAlertBand(0.7999)).toBe('hold');
  });

  it('honours custom warn / re-arm ratios', () => {
    expect(contextAlertBand(0.6, 0.5, 0.4)).toBe('enter');
    expect(contextAlertBand(0.45, 0.5, 0.4)).toBe('hold');
    expect(contextAlertBand(0.39, 0.5, 0.4)).toBe('exit');
  });

  it('models the no-flap loop: enter once, hold while draining, exit, re-enter', () => {
    // Climbing past the threshold arms a single warning.
    expect(contextAlertBand(0.81)).toBe('enter');
    // A small dip that stays in the dead-band does NOT re-arm.
    expect(contextAlertBand(0.78)).toBe('hold');
    expect(contextAlertBand(0.82)).toBe('enter'); // still armed → caller dedupes
    // Compression drops it under the floor: re-arm.
    expect(contextAlertBand(0.55)).toBe('exit');
    // Next genuine climb fires again.
    expect(contextAlertBand(0.85)).toBe('enter');
  });
});
