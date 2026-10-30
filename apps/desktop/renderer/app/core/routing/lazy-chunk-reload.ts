const RELOAD_KEY = 'devia.lazy-chunk-reload';

const DYNAMIC_IMPORT_FAILURES = [
  'Failed to fetch dynamically imported module',
  'Importing a module script failed',
  'error loading dynamically imported module',
  'Load failed',
] as const;

export function isLazyChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  return DYNAMIC_IMPORT_FAILURES.some((fragment) => message.includes(fragment));
}

export async function recoverLazyImport<T>(
  loader: () => Promise<T>,
  reload: () => void = () => window.location.reload(),
): Promise<T> {
  try {
    const loaded = await loader();
    clearReloadMarker();
    return loaded;
  } catch (error) {
    if (isLazyChunkLoadError(error)) {
      const currentUrl = window.location.href;
      if (readReloadMarker() !== currentUrl) {
        writeReloadMarker(currentUrl);
        reload();
        return new Promise<T>(() => undefined);
      }
    }
    throw error;
  }
}

function readReloadMarker(): string | null {
  try {
    return sessionStorage.getItem(RELOAD_KEY);
  } catch {
    return null;
  }
}

function writeReloadMarker(value: string): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, value);
  } catch {
    // Reloading once is still the right recovery path when storage is blocked.
  }
}

function clearReloadMarker(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    // Non-fatal: the marker is only a loop guard.
  }
}
