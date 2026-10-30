import type { Routes } from '@angular/router';
import { recoverLazyImport } from './core/routing/lazy-chunk-reload';

/**
 * Root route table for the renderer (E-DSK-08 #253).
 *
 * Every route uses `loadComponent` to produce one lazy chunk per top-level
 * feature. The emitted chunk filename is derived from the imported source
 * file's name by Angular's esbuild builder — `webpackChunkName` magic
 * comments are a webpack convention and esbuild ignores them, so Pro
 * chunks are identified by giving the source files themselves a `pro-`
 * prefix.
 *
 * Naming convention:
 *   - Free chunks: `<feature>.<hash>.js`           (source: `<feature>.ts`)
 *   - Pro chunks:  `pro-<feature>.<hash>.js`       (source: `pro-<feature>.ts`)
 *
 * The Pro components use `export default class …` so the named class
 * identifier never appears in `main.js` — only the lazy chunk contains
 * it (and the chunk is run through the obfuscation pass too). That keeps
 * the smoke test `grep PinnedComponent main.js` honest.
 *
 * Non-Pro routes (queue, git, voice, mcp, skills, settings) listed in the
 * ticket are NOT yet defined here — they live today as embedded panels or
 * modals, not navigation targets. Adding placeholder routes for them
 * would create dead URLs without UI access. They are documented in
 * `user-todo.md` as a follow-up once their UIs are extracted.
 */
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      recoverLazyImport(() =>
        import('./features/chat/chat-route.component')
          .then((m) => m.ChatRouteComponent),
      ),
    data: { chunkName: 'chat' },
  },
  {
    path: 'pinned',
    loadComponent: () =>
      recoverLazyImport(() =>
        import('./features/pro/pinned/pro-pinned.component')
          .then((m) => m.default),
      ),
    data: { chunkName: 'pro-pinned', pro: true },
  },
  {
    path: 'multi-execution',
    loadComponent: () =>
      recoverLazyImport(() =>
        import('./features/pro/multi-execution/pro-multiexec.component')
          .then((m) => m.default),
      ),
    data: { chunkName: 'pro-multiexec', pro: true },
  },
  // Catch-all → chat. A clicked notification or a stale persisted URL
  // (the renderer reload preserves the path) lands the user on the
  // default surface instead of an empty outlet.
  {
    path: 'kanban',
    loadComponent: () =>
      recoverLazyImport(() =>
        import('./features/kanban/kanban-modal.component')
          .then((m) => m.KanbanModalComponent),
      ),
    data: { chunkName: 'kanban' },
  },
  { path: '**', redirectTo: '' },
];
