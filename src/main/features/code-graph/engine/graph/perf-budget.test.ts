import { describe, expect, it } from 'vitest';
import { measureCalibrationMs, perfBudget } from './test-graph';

describe('perfBudget', () => {
  it('never returns less than the idle budget and stays within a 1..12 factor', () => {
    const b = perfBudget(300, undefined, false);
    expect(b).toBeGreaterThanOrEqual(300);
    expect(b).toBeLessThanOrEqual(300 * 12);
    const factor = b / 300;
    expect(factor).toBeGreaterThanOrEqual(1);
    expect(factor).toBeLessThanOrEqual(12);
  });

  it('caps the slowdown at 12x so a real regression still fails', () => {
    expect(perfBudget(100, () => 1_000_000, false)).toBe(1200);
  });

  it('is exactly the idle budget on a fast machine', () => {
    expect(perfBudget(100, () => 0.001, false)).toBe(100);
  });

  it('scales proportionally in between', () => {
    const idle = perfBudget(100, () => 9.5, false);
    expect(idle).toBe(100);
    expect(perfBudget(100, () => 28.5, false)).toBeCloseTo(300, 6);
  });

  // GitHub's shared runners measured ~4x slower than a dev machine on the 50k-node
  // workloads while the calibration read only ~1.2x, so a test failed by 3% (2413 ms
  // against 2340 ms) with no regression. CI gets an allowance on top of the calibration.
  describe('on CI', () => {
    it('allows 2.5x on top of the calibrated slowdown', () => {
      expect(perfBudget(100, () => 9.5, true)).toBe(250);
      expect(perfBudget(100, () => 11.1, true)).toBeCloseTo(100 * (11.1 / 9.5) * 2.5, 6);
    });

    it('still caps at 12x, so a real regression fails on CI too', () => {
      expect(perfBudget(100, () => 1_000_000, true)).toBe(1200);
    });

    it('would have passed the run that failed: 2413 ms against a budget calibrated at 2340 ms', () => {
      expect(2413).toBeLessThan(perfBudget(2000, () => 9.5 * (2340 / 2000), true));
    });

    it('is only on when the CI variable is set', () => {
      const saved = process.env['CI'];
      try {
        process.env['CI'] = 'true';
        expect(perfBudget(100, () => 9.5)).toBe(250);
        delete process.env['CI'];
        expect(perfBudget(100, () => 9.5)).toBe(100);
        process.env['CI'] = '';
        expect(perfBudget(100, () => 9.5)).toBe(100);
      } finally {
        if (saved === undefined) delete process.env['CI'];
        else process.env['CI'] = saved;
      }
    });
  });

  it('calibration workload returns a positive time', () => {
    expect(measureCalibrationMs()).toBeGreaterThan(0);
  });
});
