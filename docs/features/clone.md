# Clone

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Clone a git repository into the workspace from the "new project" flow.

## Does

- `clone:run` runs `git clone <url> <dst>` (spawned on PATH) with the destination resolved inside the workspace (`resolveInsideWorkspace`); streams `clone:start`, `clone:output` (line by line) and `clone:end` (`code`, `fullPath` or `error`).
- Project name must match `^[a-zA-Z0-9._-]+$`; refuses an existing destination folder; 10-minute timeout (`CLONE_TIMEOUT_MS`, SIGTERM).

## Does NOT

- Does NOT authenticate: it relies on the user's git credentials/ssh agent.
- Does NOT support shallow/branch options or submodule flags.
- Error messages are Spanish strings in code (`git clone terminó con código …`).

## Entry points

- `src/main/features/clone/index.ts:buildCloneFeature` — whole feature

## IPC / MCP surface

- `clone:run` (renderer → main), `clone:start`, `clone:output`, `clone:end` (main → renderer).

## Persistence

None (writes the cloned repository under `workspaceRoot`).

## Config

`workspaceRoot`.

## Gotchas

- A comment in the feature notes per-agent config is left alone when the cloned repo already ships its own.

## Tests

None: `src/main/features/clone/` contains only `index.ts` (no test file).

## Related

[workspace.md](workspace.md)
