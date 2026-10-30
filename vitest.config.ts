import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Anchor the project root to this file so include/coverage globs resolve
  // wherever vitest is launched from.
  root: __dirname,
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts', 'tools/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // The WHOLE main process and shared domain, not a whitelist.
      //
      // This used to list nine files. The thresholds below then read 80/60 and
      // looked like a quality gate, but they measured 582 statements out of
      // ~13 700 — a number that could only ever say "those nine files are still
      // fine". Worse than no number, because it bought false confidence.
      //
      // Measured over the real surface: 61.2% statements, 58.0% branches,
      // 52.8% functions, 63.7% lines. The thresholds are set just under that.
      //
      // RATCHET: these only ever go UP. When a change pushes the real number
      // above a threshold by a comfortable margin, raise the threshold in the
      // same PR. Never lower one to make a build green — that is the whole
      // point of the mechanism.
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 62,
        functions: 50,
        branches: 55,
        statements: 60,
      },
    },
  },
});
