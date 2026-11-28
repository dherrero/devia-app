# Run modes (plan / apply / apply-yolo)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Per-instruction permission level chosen in the composer, persisted per session, and translated by each agent's definition into its own flags.

## Does

- `RunMode = 'plan' | 'apply' | 'apply-yolo'` (`src/shared/domain/run-capabilities.ts`); a `RunCapabilities` descriptor is minted for every run and passed to `def.buildExtraArgs(opts)`.
- Persistence: `PersistedSession.runMode` is written by every `chats:save`/`chats:save-as` and restored on `session:switch`/`session:adopt`; at startup `seedRunModes` (`src/main/shared/seed-run-modes.ts`) seeds `RunModeStore` (`src/main/shared/run-mode-store.ts`) from each project's active session; a brand-new session starts in plan. Changing mode only schedules a save when the chat has messages.
- Plan mode adds the plan protocol to the system prompt (explore read-only → persist the plan on the kanban → `devia_plan_approve` → never implement). With the Devia Method active, `METHOD_PLAN_PROTOCOL` replaces it ([starter-kits.md](starter-kits.md)).
- "Accept plan" cannot change the in-flight run's flags: Devia ends the turn, switches the session to `apply` (or `apply-yolo` for "accept and don't ask") and queues a follow-up carrying the plan ([ui-tools.md](ui-tools.md)).
- Per-agent enforcement (from the `buildExtraArgs` of each def in `src/main/features/cli-adapters/infrastructure/defs/`):

| Agent | plan | apply | apply-yolo |
| --- | --- | --- | --- |
| claude | `--permission-mode default` + denylist of file writers | `--permission-mode acceptEdits` | `--dangerously-skip-permissions` |
| codex | `--sandbox danger-full-access` (prompt discipline, see Gotchas) | `--sandbox workspace-write` + network (Windows: full access) | `--dangerously-bypass-approvals-and-sandbox` |
| gemini | `--approval-mode plan` + per-run `--policy` file | `--approval-mode yolo` | `--approval-mode yolo` |
| opencode | `--agent plan` | `--dangerously-skip-permissions` | `--dangerously-skip-permissions` |
| cursor-agent | `--mode plan` | `--force` | `--force` |
| copilot | `--allow-all-tools` + `--deny-tool write` + `--deny-tool shell` | `--allow-all-tools` + deny `shell(rm:*)`, `shell(git push)` | `--allow-all` |
| qwen | `--approval-mode plan` | `--yolo` | `--yolo` |
| qoder | `--permission-mode plan` | `--permission-mode accept_edits` | `--permission-mode bypass_permissions` |
| pi | `--tools read,grep,find,ls,mcp__*` | `--tools` write set (`+bash,+edit,+write`) | same |
| ACP agents | permission policy in `acp/permissions.ts` + `planEnforcement` | asks | broadest allow on desktop |
| grok, deepseek | none (neither def defines `buildExtraArgs`, so mode changes nothing in argv; plan rides on the prompt protocol only) | same | same |

## Does NOT

- Does NOT make plan mode a hard sandbox for every agent: Codex plan rides on prompt discipline (upstream issue openai/codex#16685 cancels MCP calls under a managed sandbox), pi/OpenCode/Copilot depend on their own tool lists, and ACP agents with `planEnforcement: 'none'` only get a prompt guard.
- Does NOT widen `apply` to arbitrary Bash for Claude (`acceptEdits` cannot be extended by a headless `-p` run); executing an approved plan therefore uses `apply-yolo`.
- Does NOT restore a mode for a session whose file has none (absent ⇒ plan).

## Entry points

- `src/shared/domain/run-capabilities.ts:RunMode` — type and default capability builder
- `src/main/shared/run-mode-store.ts:RunModeStore` — live mode per session identity
- `src/main/shared/seed-run-modes.ts` — startup seeding
- `src/main/features/claude-runner/infrastructure/plan-protocol.ts` — plan-mode prompt contract
- `src/main/features/cli-adapters/infrastructure/defs/` — per-agent flags
- `src/renderer/app/features/chat/composer/` — mode selector

## IPC / MCP surface

- IPC `runMode:get`, `runMode:set`, `runMode:changed`; Telegram `/mode plan|apply|yolo`.

## Persistence

`runMode` inside `~/.devia-app/sessions/<project>/session-<uuid>.json`.

## Config

None (mode is per session, not in `DeviaConfig`).

## Gotchas

- `extraAllowedDirs` (whole-workspace visibility) is granted only in confined modes (plan/apply); apply-yolo omits it. Under `apply` this auto-approves edits across every workspace project for Claude and Codex.
- Codex resume cannot take `--sandbox`; the def uses `-c sandbox_mode="<level>"` instead.

## Tests

- `src/main/features/cli-adapters/infrastructure/defs/*.test.ts`, `src/main/shared/run-mode-store.test.ts`, `src/main/shared/seed-run-modes.test.ts`.

## Related

- [claude-runner.md](claude-runner.md), [agents.md](agents.md), [sessions.md](sessions.md), [../reference/agents-matrix.md](../reference/agents-matrix.md)
