# Shell actions

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Open or reveal a file or folder, open a project in an IDE, and open the upgrade link.

## Does

- `shell:openPath` and `shell:reveal` pass through `decideShellPath(raw, roots)` (`src/main/features/shell/path-policy.ts`): only paths inside the allowed roots (workspace, outbox-archive, attachments …) after symlink resolution on both sides; only a safe set of media is opened, everything else is revealed in the file manager; a missing path is denied.
- `shell:listIdes` / `shell:openInIde` use the IDE catalog (`src/shared/domain/ide.ts`, `buildIdeSpawn`, `availableIdes`): vscode, cursor, windsurf, zed, sublime, intellij, webstorm, pycharm, android-studio, xcode, with per-OS launch handles (macOS `open -a`, Windows/Linux CLI on PATH) detected in `src/main/features/shell/ide.ts`.
- `shell:open-upgrade` builds the upgrade deep link from `DEVIA_SAAS_URL` (`buildUpgradeUrl`, slug URL-encoded, trailing slash stripped); with no origin configured it opens nothing.

## Does NOT

- Does NOT execute arbitrary commands (that is [terminal.md](terminal.md) or Telegram `/exec`).
- Does NOT open paths outside the allowed roots.

## Entry points

- `src/main/features/shell/index.ts:buildShellFeature` — IPC
- `src/main/features/shell/path-policy.ts:decideShellPath`
- `src/main/features/shell/ide.ts` — IDE detection
- `src/shared/domain/ide.ts:IDE_CATALOG`

## IPC / MCP surface

- `shell:openPath`, `shell:reveal`, `shell:openInIde`, `shell:listIdes`, `shell:open-upgrade`.

## Persistence

None.

## Config

Env `DEVIA_SAAS_URL` (optional).

## Gotchas

- The renderer hands these channels paths an agent may have chosen (outbox cards, tool-call chips), hence the policy.

## Tests

`src/main/features/shell/**/*.test.ts`.

## Related

[security.md](security.md), [outbox.md](outbox.md)
