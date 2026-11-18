import { describe, expect, it } from 'vitest';
import {
  getExploreCallBudget,
  getExploreOutputBudget,
} from './explore-budget';

describe('explore budgets', () => {
  it('matches the tier table', () => {
    const t = (n: number) => {
      const b = getExploreOutputBudget(n);
      return [b.maxChars, b.maxCharsPerFile, getExploreCallBudget(n)];
    };
    expect(t(0)).toEqual([18_000, 3800, 1]);
    expect(t(499)).toEqual([18_000, 3800, 1]);
    expect(t(500)).toEqual([28_000, 6500, 2]);
    expect(t(4999)).toEqual([28_000, 6500, 2]);
    expect(t(5000)).toEqual([35_000, 7000, 3]);
    expect(t(14_999)).toEqual([35_000, 7000, 3]);
    expect(t(15_000)).toEqual([38_000, 7000, 4]);
    expect(t(24_999)).toEqual([38_000, 7000, 4]);
    expect(t(25_000)).toEqual([38_000, 7000, 5]);
  });

  it('never decreases any limit when the project grows', () => {
    let prev = getExploreOutputBudget(0);
    let prevCalls = getExploreCallBudget(0);
    for (let n = 1; n <= 60_000; n += 7) {
      const b = getExploreOutputBudget(n);
      expect(b.maxCharsPerFile).toBeGreaterThanOrEqual(prev.maxCharsPerFile);
      expect(b.maxChars).toBeGreaterThanOrEqual(prev.maxChars);
      expect(b.maxFiles).toBeGreaterThanOrEqual(prev.maxFiles);
      expect(getExploreCallBudget(n)).toBeGreaterThanOrEqual(prevCalls);
      prev = b;
      prevCalls = getExploreCallBudget(n);
    }
    for (const n of [100, 1000, 10_000, 20_000, 30_000]) {
      expect(getExploreOutputBudget(n).maxCharsPerFile).toBeGreaterThan(0);
    }
  });
});
