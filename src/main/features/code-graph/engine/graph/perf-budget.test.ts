import { describe, expect, it } from 'vitest';
import { measureCalibrationMs, perfBudget } from './test-graph';

describe('perfBudget', () => {
  it('never returns less than the idle budget and stays within a 1..12 factor', () => {
    const b = perfBudget(300);
    expect(b).toBeGreaterThanOrEqual(300);
    expect(b).toBeLessThanOrEqual(300 * 12);
    const factor = b / 300;
    expect(factor).toBeGreaterThanOrEqual(1);
    expect(factor).toBeLessThanOrEqual(12);
  });

  it('caps the slowdown at 12x so a real regression still fails', () => {
    expect(perfBudget(100, () => 1_000_000)).toBe(1200);
  });

  it('is exactly the idle budget on a fast machine', () => {
    expect(perfBudget(100, () => 0.001)).toBe(100);
  });

  it('scales proportionally in between', () => {
    const idle = perfBudget(100, () => 9.5);
    expect(idle).toBe(100);
    expect(perfBudget(100, () => 28.5)).toBeCloseTo(300, 6);
  });

  it('calibration workload returns a positive time', () => {
    expect(measureCalibrationMs()).toBeGreaterThan(0);
  });
});
