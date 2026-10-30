/**
 * Guard Analog's Zone/Vitest patch for runners that execute setupFiles more
 * than once in the same worker. The upstream setup throws if it is reloaded.
 */
const vitestGlobal = globalThis as Record<string, unknown>;

if (vitestGlobal['__vitest_zone_patch__'] !== true) {
  await import('@analogjs/vite-plugin-angular/setup-vitest');
}

const { setupTestBed } = await import('@analogjs/vitest-angular/setup-testbed');
setupTestBed({ zoneless: false });

export {};
