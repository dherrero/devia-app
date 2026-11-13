import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Anchor the project root to this file so include/coverage globs resolve
  // wherever vitest is launched from.
  root: __dirname,
  test: {
    environment: 'node',
    execArgv: ['--disable-warning=ExperimentalWarning'],
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
      // Re-measured for S-44 T-514 (2026-11-13, 3792 tests): 75.4% statements,
      // 70.12% branches, 70.94% functions, 77.81% lines (src/main/features/
      // code-graph alone: 90.7 / 81.5 / 94.7 / 94.0). Thresholds raised from
      // 62/50/55/60 to ~3 points under those numbers (lines/functions/
      // branches/statements 74/67/67/72): platform-dependent branches (win32/
      // darwin paths) and timing-dependent tests move them by more than the
      // 0.1-0.9 pt a floored threshold would leave, and this is still a raise.
      //
      // RATCHET: these only ever go UP. When a change pushes the real number
      // above a threshold by a comfortable margin, raise the threshold in the
      // same PR. Never lower one to make a build green — that is the whole
      // point of the mechanism.
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/__fixtures__/**'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 74,
        functions: 67,
        branches: 67,
        statements: 72,
      },
    },
  },
});
