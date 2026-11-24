# Snapshots

Status: partial
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Capture files before a destructive config operation so the user can restore them.

## Does

- `SnapshotCreateUseCase` captures a set of files into `<deviaDir>/snapshots/<feature>/<id>/` (`manifest.json` + one gzip per existing file), with fingerprint dedup (sha256 of path + content over the 20 most recent manifests).
- Retention (`SnapshotRetentionUseCase`): per feature keeps at most 10 unpinned snapshots and drops those older than 30 days; pinned ones are exempt; runs after each create and on boot.
- Restore re-writes captured files and deletes files that did not exist at snapshot time (`existed: false`).
- Callers that snapshot before writing: MCP install/sync (`mcp`), skills install/remove (`skills`) and sub-agents install/remove, each given `snapshotFeature.create` in `src/main/shell/composition-root.ts`.
- UI: Settings → snapshot history dialog (`src/renderer/app/features/settings/snapshot-history/snapshot-history.component.ts`) with auto/manual filter, restore, pin, delete.

## Does NOT

- Does NOT expose snapshot creation over IPC: only the main-process use cases create them.
- `prompt-packs` and `manual` are valid `SnapshotFeature` ids, but no code path creating them was found (searched composition root and feature indexes).
- Does NOT snapshot the project's source code; only config files touched by skills, MCP and sub-agent writes.
- Does NOT use tar: each file is gzipped individually.

## Entry points

- `src/main/features/snapshot/index.ts:buildSnapshotFeature` — wiring and `create`
- `src/main/features/snapshot/application/snapshot-create.use-case.ts:SnapshotCreateUseCase`
- `src/main/features/snapshot/application/snapshot-retention.use-case.ts:SnapshotRetentionUseCase`
- `src/main/features/snapshot/infrastructure/snapshot-store.ts:SnapshotStore`
- `src/main/features/snapshot/ipc/snapshot.ipc.ts` — IPC
- `src/shared/domain/snapshot.ts` — types

## IPC / MCP surface

- `snapshot:list`, `snapshot:restore`, `snapshot:pin`, `snapshot:delete`.

## Persistence

`~/.devia-app/snapshots/<feature>/<id>/`.

## Config

None (retention constants: 10 per feature, 30 days).

## Gotchas

- The caller MUST snapshot BEFORE the destructive write, or the undo is meaningless.

## Tests

`src/main/features/snapshot/**/*.test.ts`.

## Related

[mcp.md](mcp.md), [skills.md](skills.md), [sub-agents.md](sub-agents.md), [settings.md](settings.md)
