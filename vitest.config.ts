import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/apps/front/**', // Angular: own config (apps/front/vitest.config.mts)
      '**/apps/desktop/**', // Electron satellite: own configs + pipeline (vitest.config.ts / vitest.angular.config.ts)
      '**/libs/angular-auth/**', // Angular lib: own config (happy-dom + TestBed)
      '**/libs/ui/**', // Angular UI lib: own config (happy-dom + TestBed)
      '**/tests/e2e/**', // Playwright-only; uses its own runner.
    ],
  },
  resolve: {
    alias: {
      '@dto': resolve(__dirname, 'libs/rest-dto/src/index.ts'),
      '@internal-auth': resolve(__dirname, 'libs/internal-auth/src/index.ts'),
      '@front': resolve(__dirname, 'apps/front/src'),
      '@api': resolve(__dirname, 'apps/api/src'),
      '@gateway': resolve(__dirname, 'apps/gateway/src'),
    },
  },
});
