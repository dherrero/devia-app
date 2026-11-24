# Security (audit log and guard library)

Status: partial
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Records an audit trail of agent tool calls and holds a library of security primitives; several primitives are not wired into any production path today.

## Does

- Audit log (`src/main/features/security/audit-log.ts:FileAgentAuditLog`): appends JSONL lines, minimal entry (timestamp, agent identity, project path, tool name; no prompt text or tool inputs) to `<userData>/audit.log` (`app.getPath('userData')`, the Electron user-data folder, NOT `~/.devia-app/`), rotates by timestamp (`audit.log.<isoTs>.jsonl`, never overwrites history; rotation at 1 MiB), 30-day retention; wired by the run core and `claude.ipc.ts`; read through `audit:read`. Outbound-file outcomes are audited with name and size only.
- Secrets at rest: `src/main/shared/secret-vault.ts` seals small secrets (e.g. the Telegram token) with Electron `safeStorage`, falling back to app-embedded AES-256-GCM when no OS keychain exists.
- Path safety in use: `resolveInsideWorkspace` (`src/main/shared/workspace-paths.ts`) before any filesystem operation on user-supplied paths; `decideShellPath` ([shell.md](shell.md)); `checkOutboundFile` + `RunFileGate` with the code-constant `SECRET_PATH_PATTERNS` ([telegram-controller.md](telegram-controller.md)); `parsePersistedSession` at every session boundary; `classifyDetectionError` strips host paths from detection errors; prompt-pack and skill scanners reject symlinks; the code-graph reader uses `lstat` and never follows symlinks.
- See the list of guards that must not be reverted: [../architecture/security-guards.md](../architecture/security-guards.md).

## Does NOT

- Does NOT wire `env-slicer.ts` (`ConcreteEnvSlicer`), `ssrf-validator.ts` (`SsrfValidator`), `tool-token-issuer.ts` (`ConcreteToolTokenIssuer`) or `workspace-boundary.ts` (`SimpleWorkspaceBoundary`) into any production code: no importer outside `src/main/features/security/` and tests (searched `src/main` and `src/shared`). Child processes inherit the host environment ([cli-adapters.md](cli-adapters.md)).
- Does NOT sandbox agents: confinement depends on each CLI's own flags ([run-modes.md](run-modes.md)).
- Does NOT encrypt chat history, memory or the audit log at rest.
- The audit log records tool names and identities, never contents.

## Entry points

- `src/main/features/security/audit-log.ts:FileAgentAuditLog` — in use
- `src/main/features/security/env-slicer.ts:ConcreteEnvSlicer` — library only
- `src/main/features/security/ssrf-validator.ts:SsrfValidator` — library only
- `src/main/features/security/tool-token-issuer.ts:ConcreteToolTokenIssuer` — library only
- `src/main/features/security/workspace-boundary.ts:createWorkspaceBoundary` — library only
- `src/main/shared/secret-vault.ts` — secret sealing
- `src/main/shared/workspace-paths.ts:resolveInsideWorkspace`

## IPC / MCP surface

- `audit:read`.

## Persistence

`<userData>/audit.log` (+ rotated `audit.log.<isoTs>.jsonl`), where `<userData>` is `app.getPath('userData')` (macOS: `~/Library/Application Support/<app name>`). AGENTS.md and the old README listed `~/.devia-app/audit.log`; the code (`src/main/shell/composition-root.ts`) uses userData.

## Config

None.

## Gotchas

- The folder has no `index.ts` (it is not a registered feature); the audit logger is constructed in `src/main/shell/composition-root.ts`.

## Tests

`src/main/features/security/*.test.ts`.

## Related

[../architecture/security-guards.md](../architecture/security-guards.md), [telegram-controller.md](telegram-controller.md), [shell.md](shell.md)
