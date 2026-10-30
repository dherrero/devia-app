/**
 * UC-FIX-019: Vitest configuration for Angular renderer component tests.
 *
 * Separate from vitest.config.ts (which covers src-main) so the Angular
 * compiler and jsdom environment only apply to renderer spec files.
 *
 * `root` is anchored to this file so include/setup globs resolve correctly
 * whether vitest runs from the workspace root (`nx test:renderer desktop`,
 * where process.cwd() is the repo root) or from apps/desktop directly.
 */
import { defineConfig } from 'vitest/config';
import { join } from 'path';
import angular from '@analogjs/vite-plugin-angular';

export default defineConfig({
  root: __dirname,
  plugins: [
    angular({ tsconfig: join(__dirname, 'tsconfig.app.json') }),
  ],
  resolve: {
    alias: {
      '@devia/ui': join(__dirname, '../../libs/ui/src/index.ts'),
      '@devia/styles': join(__dirname, '../../libs/styles/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    pool: 'threads',
    fileParallelism: false,
    setupFiles: [join(__dirname, 'renderer/vitest-angular-setup.ts')],
    include: ['renderer/**/*.spec.ts'],
    reporters: ['verbose'],
  },
});
