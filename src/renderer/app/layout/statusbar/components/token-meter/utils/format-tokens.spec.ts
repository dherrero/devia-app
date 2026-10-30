import { describe, it, expect } from 'vitest';
import { formatTokens } from './format-tokens';

describe('formatTokens (HT-C-03)', () => {
  it('renders raw integers below 1000', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(512)).toBe('512');
    expect(formatTokens(999)).toBe('999');
  });

  it('keeps the .X decimal in the k band only when it carries information', () => {
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(28_100)).toBe('28.1k'); // OpenDesign mockup
    expect(formatTokens(999_900)).toBe('999.9k');
  });

  it('drops trailing .0 so clean multi-k numbers stay compact', () => {
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(10_000)).toBe('10k');
    expect(formatTokens(28_000)).toBe('28k');
    expect(formatTokens(200_000)).toBe('200k');
    expect(formatTokens(999_000)).toBe('999k');
  });

  it('switches to M for ≥ 1,000,000 with the same trim rule', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(formatTokens(2_000_000)).toBe('2M');
  });

  it('clamps negatives to 0 (defensive against bad IPC payloads)', () => {
    expect(formatTokens(-1)).toBe('0');
    expect(formatTokens(-12_345)).toBe('0');
  });

  it('renders a placeholder dash for non-finite inputs', () => {
    expect(formatTokens(Number.NaN)).toBe('—');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatTokens(Number.NEGATIVE_INFINITY)).toBe('—');
  });
});
