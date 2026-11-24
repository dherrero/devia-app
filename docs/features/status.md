# Status telemetry

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Process and git state snapshot used by the status surfaces.

## Does

- `GetStatusUseCase` (`src/main/features/status/application/get-status.use-case.ts`) walks the project registry and returns `{ runningCount, projects: [{ name, isRunning, newSession, git }] }`; `status:get` serves it to the Status modal.

## Does NOT

- Does NOT stream: it is a pull snapshot.
- Does NOT include cost or context (see [session-stats.md](session-stats.md)).

## Entry points

- `src/main/features/status/index.ts:buildStatusFeature`
- `src/main/features/status/application/get-status.use-case.ts:GetStatusUseCase`
- `src/main/features/status/ipc/status.ipc.ts`
- `src/renderer/app/features/settings/status-modal/status-modal.component.ts`

## IPC / MCP surface

- `status:get`.

## Persistence

None.

## Config

None.

## Gotchas

None.

## Tests

`src/main/features/status/**/*.test.ts` where present.

## Related

[settings.md](settings.md), [git.md](git.md)
