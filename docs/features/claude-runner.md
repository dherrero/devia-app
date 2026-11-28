# Claude runner (agent-agnostic run core)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Decides WHAT a run needs (mode, composed system prompt, Devia's and the user's MCP servers, UI tools, resume handle, memory, handoff, worktree), builds an `AgentRunPlan`, and manages the run lifecycle and every user-facing card of the run. Despite the folder name it knows no agent: agent specifics live in [agents.md](agents.md).

## Does

- `RunInstructionUseCase` (`src/main/features/claude-runner/application/run-instruction.use-case.ts`): one run per instruction. Resolves cwd (session worktree for an isolated pane) and the BASE checkout (`projectCheckout`) used for memory/kanban identity, composes the system prompt, resolves the UI-tool set before composing it (`uiTools = { delivered, advertised }`), asks the mapper to `resolveDelivery` then `prepareRun`, spawns through the launcher, decodes the stream.
- Keys registry, queue and event dispatch by identity `runKey ?? projectName`, so two panes of one repo never collide ([split-view.md](split-view.md)).
- `RunInteraction` (`.../application/run-interaction.ts`): owns the `devia-ui` rendezvous poller (100 ms), the agent's own dialogs, answer routing, and arms the `QUESTION_TIMEOUT_MS` kill (constant in `run-instruction.use-case.ts`) for BLOCKING requests only, and the last `fireAndForgetOnly` pass on stop. See [ui-tools.md](ui-tools.md).
- Composes the prompt from bodies: `system-prompt.ts`, `plan-protocol.ts` (plan mode contract), `ui-tools-protocol.ts`, `remote-protocol.ts`, `worktree-protocol.ts`, `memory-protocol.ts`, `memory-context-hint.ts`; `prompt-bodies.ts` (`splitBodies`) splits `stable` vs `turn` for agents that freeze their system prompt; `turn-context.ts` / `turn-context-tracker.ts` build and track the `<devia-turn-context>` block.
- Whole-workspace visibility: in `plan` and `apply` it passes `extraAllowedDirs = [workspaceRoot]` (mapped to `--add-dir` / `--include-directories` where the CLI supports it); `apply-yolo` omits it.
- Delivers harness (skills, sub-agents) through `HarnessCatalog` (`.../infrastructure/harness-catalog.ts`).
- Detects an enterprise managed MCP config (`.../infrastructure/enterprise-mcp-detector.ts:enterpriseMcpConfigPresent`); when present neither `--mcp-config` nor `--strict-mcp-config` is passed and Devia's servers are not injected for that run.
- Auto-resume after a usage limit: `AutoResumeScheduler` ([auto-continue.md](auto-continue.md)).
- Stop/reset: `StopProjectUseCase`, `StopAllUseCase`, `ResetSessionUseCase` (a reset first stops the in-flight run).
- Writes passive memory capture at run end (`.../infrastructure/memory-capture.ts`, [memory.md](memory.md)).

## Does NOT

- Does NOT contain agent-id literals or import a concrete mapper: `src/main/features/claude-runner/application/core-is-agent-agnostic.test.ts` fails otherwise.
- Does NOT spawn processes itself (the launcher in [cli-adapters.md](cli-adapters.md) does).
- Does NOT offer a permission approver: runs are headless, so for Claude every Devia-managed MCP server is auto-granted in `.claude/settings.local.json` (`grantClaudeMcpAccess`).
- In `apply` mode (`acceptEdits`, no approver) Claude also gets an allow-list to create its work branch and commit (`grantClaudeWorkBranchAccess`: `git checkout -b`, `git switch -c`, `git add`, `git commit`, read-only status/branch). Never push, delete branches or force; `plan` does not get it and `apply-yolo` skips permissions anyway (S-60).
- Does NOT keep a pending auto-resume across app restarts (memory only).

## Entry points

- `src/main/features/claude-runner/index.ts:buildClaudeRunnerFeature` — wiring and deps
- `src/main/features/claude-runner/application/run-instruction.use-case.ts:RunInstructionUseCase` — the run
- `src/main/features/claude-runner/application/run-interaction.ts:RunInteraction` — cards, answers, timers
- `src/main/features/claude-runner/application/auto-resume-scheduler.ts:AutoResumeScheduler` — resume after limit
- `src/main/features/claude-runner/application/reset-session.use-case.ts:ResetSessionUseCase` — reset
- `src/main/features/claude-runner/infrastructure/prompt-bodies.ts:splitBodies` — stable/turn split
- `src/main/features/claude-runner/infrastructure/turn-context-tracker.ts:TurnContextTracker` — resend policy
- `src/main/features/claude-runner/ipc/claude.ipc.ts` — IPC handlers
- `src/main/shared/run-gateway.ts` — gateway used by Telegram to submit/mirror runs

## IPC / MCP surface

- IPC: `instruction:send`, `process:start`, `process:end`, `process:stop`, `process:stop-all`, `run:cancel`, `session:reset`, `autoresume:cancel`, `claude:output`, `question:ask`, `question:answer`, `ui:tool-request`, `ui:tool-result`.
- Bundled MCP servers it injects: see [../reference/mcp-servers.md](../reference/mcp-servers.md).

## Persistence

- Per-run temp files under `<deviaDir>/tmp/` (MCP configs, code-mode servers file, pi extension), owner-only, removed after the run.
- UI rendezvous directory `os.tmpdir()/devia-ui/<runId>`.

## Config

`agentId`, `agentModels`, `agentCliEnv`, per-agent effort, `memory`, `uiTools`, `remoteControl`, `starterKits`, `autoContinueSessions`, `workspaceRoot` (see [../reference/config.md](../reference/config.md)).

## Gotchas

- Enterprise MCP carve-out (T-88): under an enterprise-managed Claude MCP config, Claude forbids BOTH `--strict-mcp-config` and `--mcp-config` (either aborts the run). `enterpriseMcpConfigPresent()` probes the standalone `managed-mcp.json` (mere presence as a valid JSON object with an `mcpServers` key activates the policy, even when empty) and, legacy, a non-empty `mcpServers` embedded in `managed-settings.json`. Paths: `managed-mcp.json` at `/Library/Application Support/ClaudeCode/` (macOS), `/etc/claude-code/` (Linux/WSL), `C:\Program Files\ClaudeCode\` (Windows: `Program Files`, NOT `ProgramData`); `managed-settings.json` on Windows is under `%PROGRAMDATA%`. When present the run passes neither flag and Devia's servers are not injected (a status notice says so); a Claude matcher classifies both abort messages with an actionable hint as a safety net.
- Conversation continuity (S-19): the runner sends only the latest instruction and relies on native CLI resume (`agentSessionId`, captured from `session_started`); `continuity: 'replay'` agents (Gemini) get the prior transcript re-seeded through `buildConversationReplay`.
- Delivering MCP permission to non-Claude agents: other agents already run permissive at runtime (Gemini `--approval-mode yolo` + `GEMINI_CLI_TRUST_WORKSPACE`, OpenCode `--dangerously-skip-permissions`, Codex `exec --sandbox`), so writing the server definition into their native config is enough; Cursor and Copilot have no yolo flag and their headless trust mechanism is UNVERIFIED.

- `Workflow` (Claude's built-in multi-agent tool, ~4.5k tokens of cached prefix) is disallowed in every mode except `plan` through the Claude mapper's `disallowedTools(mode)`.
- "Accept plan" cannot change the mode of the run in flight (flags are fixed in argv): the tool result tells the agent to end its turn, Devia switches the session mode and queues a follow-up instruction.
- Anything volatile (channel, mode, tools on offer, worktree notice) must NOT live in a frozen system prompt: see the per-turn-context section of [agents.md](agents.md).
- The grants file `.claude/settings.local.json` is read from the run's cwd, so grants stay on the effective cwd while memory/kanban identity uses the base checkout.

## Tests

- `src/main/features/claude-runner/application/run-instruction.use-case.test.ts` (large; "S-40" and "code mode gateway" describes), `src/main/features/claude-runner/application/core-is-agent-agnostic.test.ts`, per-file tests beside each module.

## Related

- [agents.md](agents.md), [cli-adapters.md](cli-adapters.md), [run-modes.md](run-modes.md), [ui-tools.md](ui-tools.md), [session-handoff.md](session-handoff.md), [../architecture/agent-layers.md](../architecture/agent-layers.md)
