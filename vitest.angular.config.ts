/**
 * UC-FIX-019: Vitest configuration for Angular renderer component tests.
 *
 * Separate from vitest.config.ts (which covers src/main) so the Angular
 * compiler and jsdom environment only apply to renderer spec files.
 *
 * `root` is anchored to this file so include/setup globs resolve correctly
 * wherever vitest is launched from.
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
      '@devia/ui': join(__dirname, 'src/libs/ui/src/index.ts'),
      '@devia/styles': join(__dirname, 'src/libs/styles/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    pool: 'threads',
    fileParallelism: false,
    setupFiles: [join(__dirname, 'src/renderer/vitest-angular-setup.ts')],
    include: ['src/renderer/**/*.spec.ts'],
    reporters: ['verbose'],
  },
});
