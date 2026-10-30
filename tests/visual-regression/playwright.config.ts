import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

/**
 * Visual regression config for the desktop renderer (HT-QA-01).
 *
 * - Spins up Chromium headless against the static renderer build.
 * - Fixed viewport (1440 × 900) so the layout grid track widths are
 *   deterministic across machines.
 * - Disable animations by emulating `prefers-reduced-motion: reduce`;
 *   the global `@media` block then clamps every transition / animation
 *   to 0 ms, so screenshots aren't taken mid-frame.
 * - `toHaveScreenshot` tolerates a 5 % pixel diff to swallow font-render
 *   noise across operating systems.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.ts',
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: join(__dirname, '.playwright-output'),

  use: {
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    // The renderer is served as a static bundle by the per-spec
    // fixtures; no baseURL needed at the project level.
  },

  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.05,
      animations: 'disabled',
      caret: 'hide',
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
