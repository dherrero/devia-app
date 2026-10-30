import { describe, expect, it, vi } from 'vitest';
import { isLazyChunkLoadError, recoverLazyImport } from './lazy-chunk-reload';

describe('lazy chunk reload recovery', () => {
  it('recognises stale dynamic import failures', () => {
    expect(isLazyChunkLoadError(new TypeError(
      'Failed to fetch dynamically imported module: http://127.0.0.1:4300/kanban-modal.component-64BFXMJK.js',
    ))).toBe(true);
    expect(isLazyChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isLazyChunkLoadError(new Error('regular application error'))).toBe(false);
  });

  it('clears the one-shot reload marker after a successful import', async () => {
    sessionStorage.setItem('devia.lazy-chunk-reload', window.location.href);

    await expect(recoverLazyImport(async () => 'loaded')).resolves.toBe('loaded');

    expect(sessionStorage.getItem('devia.lazy-chunk-reload')).toBeNull();
  });

  it('still reloads once when sessionStorage is unavailable', async () => {
    const originalSessionStorage = window.sessionStorage;
    const reload = vi.fn();
    try {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: {
          getItem: () => { throw new Error('blocked'); },
          setItem: () => { throw new Error('blocked'); },
          removeItem: () => { throw new Error('blocked'); },
        },
      });

      const result = recoverLazyImport(async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      }, reload);

      await Promise.resolve();
      expect(reload).toHaveBeenCalledTimes(1);
      void result;
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: originalSessionStorage,
      });
    }
  });
});
