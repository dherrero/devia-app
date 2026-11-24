# Prompt packs

Status: partial
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Named blocks of system-prompt text scanned from disk and composed into a run's system prompt.

## Does

- `scanPromptPacks` (`src/main/features/prompt-packs/infrastructure/scanner.ts`) reads `<root>/<id>/PACK.md` from the user directory `~/.devia-app/prompt-packs/` and a built-in directory `app.getAppPath()/prompt-packs/`; symlinked entries are skipped (`lstatSync` + `isSymbolicLink`).
- `PromptPackRegistry.getBodies(ids)` feeds `composeSystemPrompt` (pure concatenation of the baseline plus the selected bodies; no packs = baseline unchanged) inside `RunInstructionUseCase`.
- IPC `promptPacks:list` and `promptPacks:rescan` are exposed on the preload bridge.

## Does NOT

- Does NOT have a UI: nothing in `src/renderer` calls `listPromptPacks` / `rescanPromptPacks` or passes `promptPackIds` (searched the renderer and `claude.ipc.ts`), so a run never selects a pack today.
- Does NOT ship built-in packs: no `prompt-packs/` directory exists in the repository.
- Does NOT snapshot pack changes even though `prompt-packs` is a valid `SnapshotFeature` id.

## Entry points

- `src/main/features/prompt-packs/index.ts:buildPromptPacksFeature` — scan and IPC
- `src/main/features/prompt-packs/application/compose-system-prompt.ts:composeSystemPrompt`
- `src/main/features/prompt-packs/domain/registry.ts` — registry
- `src/main/features/prompt-packs/infrastructure/scanner.ts:scanPromptPacks`
- `src/main/features/claude-runner/application/run-instruction.use-case.ts:RunInstructionUseCase` — consumer

## IPC / MCP surface

- `promptPacks:list`, `promptPacks:rescan`.

## Persistence

`~/.devia-app/prompt-packs/<id>/PACK.md`.

## Config

None.

## Gotchas

- The `promptPackIds` parameter of `execute()` defaults to `[]` and no caller sets it.

## Tests

`src/main/features/prompt-packs/**/*.test.ts`.

## Related

[claude-runner.md](claude-runner.md), [starter-kits.md](starter-kits.md)
