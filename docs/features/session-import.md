# Session import

Status: implemented (Claude Code, OpenAI Codex, Grok)
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Let a user who already used a CLI agent bring existing sessions into Devia, with native resume where the agent supports it.

## Does

- Registry in `src/main/features/session-import/index.ts`: each source is a `SessionTranscriptReader` + a pure `TranscriptParser` (`src/main/features/session-import/parsers.ts`): `FsClaudeProjectsReader` + `claudeParser`, `FsCodexSessionsReader` + `codexParser`, `FsGrokSessionsReader` + `grokParser`. `ScanSessionsUseCase` and `ImportSessionsUseCase` iterate it.
- `ParsedTranscript` (`src/shared/domain/agent-transcript.ts`): `agentId`, `agentSessionId`, `cwd`, `messages`, timestamps, `title?`, `resumable`.
- Project identity comes from the transcript's own absolute `cwd` (never a lossy folder name); only sessions whose `cwd` is inside `workspaceRoot` are offered. Scan groups by agent → workspace-relative project.
- Import persists via `SessionStore.save`, idempotent by session id unless `force`, validates `cwd` ↔ `projectPath`, never touches the registry's active session.
- Native resume: the imported session reuses the agent's native conversation id as Devia's session id with `agentId` + `agentSessionId` stamped, so continuing it resumes the real transcript (Claude `--resume <uuid>`, Codex `exec resume <uuid>`, Grok `--session <id>`). `projectKey()` is byte-identical to Claude's lossy `<encoded-cwd>` folder naming, so the importer never reverses it.
- Parsers: `src/shared/domain/claude-transcript.ts` (aggregates a whole agentic turn into one assistant message, folds tool results from `user` lines, excludes sidechains), `codex-transcript.ts` (rollout `session_meta` + `response_item`; drops the synthetic AGENTS.md/`<environment_context>` blocks), `grok-transcript.ts` (rows from `~/.grok/grok.db` read-only via the built-in `node:sqlite`, `GROK_HOME` aware, lazy and guarded).
- Readers apply `lstat` anti-symlink and a 64 MiB cap.
- UI: `SessionImportModalComponent` (wizard grouped by agent → project, badge "native resume" vs "replay"), reachable from Settings → Execution and from a one-time first-run toast (`devia.sessionImportPrompted` in localStorage, shown only if at least one mappable session exists).

## Does NOT

- Does NOT import Gemini, OpenCode, Cursor, Copilot, pi or ACP agents (no reader/parser).
- Does NOT import sessions whose `cwd` is outside `workspaceRoot`.
- Does NOT work for Grok where `node:sqlite` is unavailable (the feature degrades to absent; no native dependency added).
- Does NOT import desktop-only: no Telegram path.

## Entry points

- `src/main/features/session-import/index.ts` — registry
- `src/main/features/session-import/application/scan-sessions.use-case.ts:ScanSessionsUseCase`
- `src/main/features/session-import/application/import-sessions.use-case.ts:ImportSessionsUseCase`
- `src/main/features/session-import/infrastructure/fs-claude-projects-reader.ts`
- `src/main/features/session-import/infrastructure/fs-codex-sessions-reader.ts`
- `src/main/features/session-import/infrastructure/fs-grok-sessions-reader.ts`
- `src/renderer/app/features/session-import/session-import-modal.component.ts` — wizard

## IPC / MCP surface

- `session-import:scan`, `session-import:run`.

## Persistence

Writes imported sessions into `~/.devia-app/sessions/` ([sessions.md](sessions.md)). Reads `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`), `~/.codex/sessions`, `~/.grok/grok.db`.

## Config

Env `CLAUDE_CONFIG_DIR`, `GROK_HOME`. i18n namespace `modals.session_import`, `toasts.session_import_*`.

## Gotchas

- Replay-only agents would keep the same stamp and be re-seeded each turn by `buildConversationReplay`; none is registered today.
- A grok `SessionTranscriptRef` carries the SESSION ID in `filePath` (one db, N sessions).
- Live verification against a real grok-dev v1.1.7 install was pending when S-21 landed.

## Tests

- `src/main/features/session-import/session-import.test.ts`, `fs-grok-sessions-reader.test.ts`, `src/shared/domain/*-transcript.test.ts`.

## Related

- [sessions.md](sessions.md), [session-handoff.md](session-handoff.md), [cli-adapters.md](cli-adapters.md)
