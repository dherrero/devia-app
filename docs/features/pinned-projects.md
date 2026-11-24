# Pinned projects

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Lets the user pin projects to the sidebar's pinned panel, including ones outside the currently browsed folder.

## Does

- `pinned:get` returns the pinned paths (annotated with their metadata); `pinned:set` replaces the list atomically, de-duplicating and rejecting non-string entries (`InMemoryPinnedStore`, `src/main/features/pinned-projects/infrastructure/in-memory-pinned-store.ts`).
- The list is persisted through the state store (`state.json`) by the feature; trashing a project drops its pins (`removeMatching`).
- Sidebar header of the pinned panel hosts "stop all processes" while any run is active.

## Does NOT

- Does NOT sync pins between machines.
- Does NOT validate that a pinned path still exists; a stale pin is cleaned when its project is trashed.

## Entry points

- `src/main/features/pinned-projects/index.ts:buildPinnedProjectsFeature` — IPC + wiring
- `src/main/features/pinned-projects/infrastructure/in-memory-pinned-store.ts:InMemoryPinnedStore` — store
- `src/renderer/app/layout/sidebar/sidebar.component.ts` — pinned panel UI

## IPC / MCP surface

- `pinned:get`, `pinned:set`.

## Persistence

`~/.devia-app/state.json` (via the state store).

## Config

None.

## Gotchas

- The store class is in-memory; durability comes from the caller persisting to `state.json`.

## Tests

`src/main/features/pinned-projects/` tests where present.

## Related

[workspace.md](workspace.md), [settings.md](settings.md)
