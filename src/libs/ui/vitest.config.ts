import { defineConfig } from 'vite';
import angular from '@analogjs/vite-plugin-angular';
import { join } from 'path';

export default defineConfig({
  plugins: [
    angular({
      tsconfig: join(__dirname, 'tsconfig.spec.json'),
    }),
  ],
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/libs/ui/src/**/*.spec.ts'],
    setupFiles: ['src/libs/ui/src/test-setup.ts'],
  },
  resolve: {
    alias: {
      '@devia/styles': join(__dirname, '../styles/src/index.ts'),
      '@devia/ui': join(__dirname, 'src/index.ts'),
    },
  },
});
