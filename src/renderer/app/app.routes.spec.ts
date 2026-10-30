import { describe, it, expect } from 'vitest';
import { routes } from './app.routes';

/**
 * Pure structural tests on the route table. The full TestBed flow
 * (RouterTestingHarness + provideRouter) would require booting Angular
 * inside vitest's jsdom env — which works but adds ~1s per spec for
 * tests that don't need the runtime. Instead we assert on the route
 * shape itself: paths, chunk-name conventions, and the data flags the
 * EntitlementChunkLoader (ticket #254) will consume.
 */
describe('app.routes', () => {
  it('defines the chat route as the default (pathMatch: full, path: "")', () => {
    const def = routes.find((r) => r.path === '');
    expect(def).toBeDefined();
    expect(def?.pathMatch).toBe('full');
    expect(def?.loadComponent).toBeTypeOf('function');
    expect((def?.data ?? {})['chunkName']).toBe('chat');
    expect((def?.data ?? {})['pro']).toBeUndefined();
  });

  it('emits at least one Pro route whose data.pro === true', () => {
    const proRoutes = routes.filter((r) => (r.data ?? {})['pro'] === true);
    expect(proRoutes.length).toBeGreaterThanOrEqual(1);
    for (const r of proRoutes) {
      const chunkName = (r.data ?? {})['chunkName'] as string | undefined;
      expect(chunkName).toBeDefined();
      expect(chunkName).toMatch(/^pro-/);
      expect(r.loadComponent).toBeTypeOf('function');
    }
  });

  it('declares the expected Pro routes by path', () => {
    const proPaths = routes
      .filter((r) => (r.data ?? {})['pro'] === true)
      .map((r) => r.path)
      .sort();
    expect(proPaths).toEqual(['multi-execution', 'pinned']);
  });

  it('declares Kanban as a non-Pro route', () => {
    const kanban = routes.find((r) => r.path === 'kanban');
    expect(kanban).toBeDefined();
    expect((kanban?.data ?? {})['chunkName']).toBe('kanban');
    expect((kanban?.data ?? {})['pro']).toBeUndefined();
    expect(kanban?.loadComponent).toBeTypeOf('function');
  });

  it('ends with a wildcard redirect to "" so stale URLs land on chat', () => {
    const wildcard = routes.find((r) => r.path === '**');
    expect(wildcard).toBeDefined();
    expect(wildcard?.redirectTo).toBe('');
  });

  it('every loadComponent factory returns a thenable that resolves to a component', async () => {
    for (const r of routes) {
      if (!r.loadComponent) continue;
      const loaded = await (r.loadComponent() as Promise<unknown>);
      expect(loaded).toBeDefined();
    }
  }, 30_000);
});
