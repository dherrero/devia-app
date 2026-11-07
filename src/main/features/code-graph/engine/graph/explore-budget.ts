export interface ExploreOutputBudget {
  maxChars: number;
  maxFiles: number;
  maxCharsPerFile: number;
}

const OUTPUT_TIERS: { below: number; budget: ExploreOutputBudget }[] = [
  { below: 500, budget: { maxChars: 18_000, maxFiles: 4, maxCharsPerFile: 3800 } },
  { below: 5000, budget: { maxChars: 28_000, maxFiles: 6, maxCharsPerFile: 6500 } },
  { below: 15_000, budget: { maxChars: 35_000, maxFiles: 8, maxCharsPerFile: 7000 } },
  { below: 25_000, budget: { maxChars: 38_000, maxFiles: 10, maxCharsPerFile: 7000 } },
];
const LARGEST: ExploreOutputBudget = {
  maxChars: 38_000,
  maxFiles: 10,
  maxCharsPerFile: 7000,
};

/** Output ceiling per project size. A larger tier never gets a smaller limit than a smaller one. */
export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  const tier = OUTPUT_TIERS.find((t) => fileCount < t.below);
  return { ...(tier?.budget ?? LARGEST) };
}

/** How many explore calls are worth making before answering, by project size. */
export function getExploreCallBudget(fileCount: number): number {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15_000) return 3;
  if (fileCount < 25_000) return 4;
  return 5;
}
