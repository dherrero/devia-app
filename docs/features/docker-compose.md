# Docker Compose

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Detect and run `docker compose` for a project from the right-rail panel.

## Does

- `docker:detect` and `compose:detect` find the CLI and the project's compose files; `compose:run` executes deploy / down / logs and streams `compose:start`, `compose:output` (line by line) and `compose:end`; `compose:search` finds compose files in the workspace.
- Renderer: `src/renderer/app/layout/right-rail/components/docker-panel/docker-panel.component.ts` with `docker-state.service.ts`.

## Does NOT

- Does NOT manage images, volumes or registries; no Kubernetes.
- Does NOT run on remote hosts.

## Entry points

- `src/main/features/docker-compose/index.ts:buildComposeFeature`
- `src/renderer/app/layout/right-rail/components/docker-panel/docker-panel.component.ts`

## IPC / MCP surface

- `docker:detect`, `compose:detect`, `compose:search`, `compose:run`, `compose:start`, `compose:output`, `compose:end`.

## Persistence

None.

## Config

None.

## Gotchas

- Over Telegram use `/exec docker compose up -d --build` when shell is enabled.

## Tests

None found next to the feature.

## Related

[telegram-controller.md](telegram-controller.md), [terminal.md](terminal.md)
