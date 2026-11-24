# Interface tools (`devia-ui` MCP server)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Serves Devia's interactive cards as MCP tools to every agent. Claude Code 2.1.220 removed `AskUserQuestion` from headless `-p` runs (verified against `system/init`), so questions, plan approval, review and confirmations travel as one bundled MCP server.

## Does

- ONE server, not eight: each MCP server costs a process spawn per run AND its tool schemas in the cached prompt prefix every turn.
- Nine tools (`IMPLEMENTED_UI_TOOLS` in `src/shared/domain/ui-tools-policy.ts`): `devia_ask_user` (blocking, plan+apply), `devia_todo` (fire-and-forget, plan+apply and remote), `devia_plan_approve` (blocking, plan only), `devia_request_review` (blocking, apply only), `devia_confirm` (blocking, apply only), `devia_pick` (blocking, apply only), `devia_notify` (apply and remote), `devia_skill` (resolved locally, wherever the project has skills), `devia_send_file` (plan+apply+yolo, ONLY when `canSendFiles`).
- Rendezvous: the server cannot call main, so they meet on disk in a per-run directory `os.tmpdir()/devia-ui/<runId>` (`src/main/shared/ui-rendezvous.ts`): `tools/call` writes `<callId>.request.json` (with a `tool` discriminator and `expectsAnswer`), the runner polls every 100 ms, the user's answer returns as `<callId>.answer.json` via `writeToolResult`; the server returns it and deletes both files. A fire-and-forget request is swept as soon as consumed. Each request is handled ONCE (`seenToolUseIds` guard, plus a renderer-side set of settled callIds).
- Two timeouts on purpose: the server's own (returns `isError` with instructions) and the runner's `QUESTION_TIMEOUT_MS` kill, armed only for BLOCKING tools.
- The gate: `uiTools = { delivered, advertised }` is resolved BEFORE the system prompt is composed, because the prompt must announce each tool or teach its plain-text equivalent; deterministic for the whole run (the set is in the server argv `--tools a,b,c`). `delivered` is false for an enterprise MCP config, an agent with no MCP target (deepseek/qoder), a failed native-config write, or an empty set. A remote (Telegram) run keeps the non-interactive tools.
- Policy (`src/shared/domain/ui-tools-policy.ts`, pure): `resolveAdvertisedUiTools` describes intent per mode; `wiredUiTools` narrows to tools the renderer can draw; the user preference `config.uiTools.enabled` can only NARROW, never widen.
- Plan flow: `devia_plan_approve` takes optional `steps` (max 20 × 200 chars, renumbered `step-1..n`); decisions are keep planning (comment, launches nothing), accept and ask (`approve_and_run` → apply), accept and don't ask (`approve_and_run_yolo` → apply-yolo); each decision is appended to the thread as `kind: 'plan'`. `buildPlanFollowUpPrompt` tells the agent to publish `devia_todo` with exactly those step ids.
- `devia_confirm` grants: `projects/<key>/ui-confirmations.json`, keyed by the BASE checkout, matching by EXACT equality of the normalised action (never prefix); actions flagged `danger` never offer "always"; the store has no cache.
- `devia_send_file`: validated twice with the same guard (`checkOutboundFile` in the server, revalidation in main via `RunFileGate`), see [telegram-controller.md](telegram-controller.md) and [security.md](security.md).
- `devia_skill` resolves inside the server against disk (`--skills-dir`, `--subagents-dir`), not through the rendezvous: name `[A-Za-z0-9_.-]`, path re-checked inside the root, symlink rejected, 256 KiB cap. It serves skills AND sub-agents (a sub-agent loads as a role) in one tool on purpose (a new schema would sit in every cached prefix).
- Prompt side: `buildUiToolsHint` announces what the run HAS; `buildUiFallbackHint` teaches plain text for what it LACKS (only the four decision tools generate fallback text); the "no interactive UI" header appears only when `ask_user` is missing.

## Does NOT

- Does NOT restore Claude's `AskUserQuestion` PreToolUse hook: there is no tool left to intercept.
- Does NOT offer decision tools to remote (Telegram) runs: `ask_user`, `plan_approve`, `request_review`, `confirm`, `pick` are withheld; agents ask in numbered plain text and the user answers in the next message.
- Does NOT widen tools beyond what the renderer draws: advertising a blocking tool with no card would hang the run until the kill timeout.
- The 8-CLI × 8-tool verification matrix and the context-cost measurement were never run; `docs/ui-tools/01-cross-agent-matrix.md` and `02-context-cost.md` are the procedure. UNVERIFIED per-CLI behaviour.

## Entry points

- `src/main/features/ui-tools/index.ts` — feature wiring and settings IPC
- `src/main/features/ui-tools/mcp-server/tool-registry.ts` — tool definitions (data)
- `src/main/features/ui-tools/mcp-server/ui-tools-call.ts` — uniform call behaviour
- `src/main/features/ui-tools/mcp-server/ui-server.ts` — JSON-RPC dispatch
- `src/main/features/ui-tools/mcp-server/server.ts` — stdio entry
- `src/main/features/ui-tools/mcp-server/ui-mcp-injector.ts` — server config
- `src/main/features/ui-tools/infrastructure/confirmation-store.ts` — grants
- `src/main/shared/ui-rendezvous.ts` — rendezvous helpers
- `src/shared/domain/ui-tools-policy.ts` — policy
- `src/main/features/claude-runner/infrastructure/ui-tools-protocol.ts` — prompt hints
- `src/renderer/app/features/chat/ui-tools/ui-tool-host.component.ts` — cards

## IPC / MCP surface

- MCP tools above; IPC `ui:tool-request`, `ui:tool-result`, plus the settings-panel channels registered by the feature.

## Persistence

`~/.devia-app/projects/<key>/ui-confirmations.json`; per-run rendezvous directory in the OS temp dir.

## Config

`config.uiTools.enabled` (per tool), `remoteControl.allowFileSend`, `remoteControl.mirrorDesktop`.

## Gotchas

- Execution panel (S-28): `ds-ui-tool-host` is not a stack of cards; one of three shapes (proposal, executing, loose). `devia_todo` feeds the stepper (a read-only `dv-stepper` from `libs/ui`, collapsed to one line, opens by itself when a step needs an answer and draws `confirm`/`pick` INSIDE the active step; after answering the card becomes a one-line note and the panel folds back) and is still upserted into the thread as `kind: 'todo'`. State lives in `UiToolsService.executionStates` per session: `steps`, `notes[stepId]`, `carryOver`. `carryOver` covers one transition: "approve and run" seeds the steps from the plan at once but the PLANNING run ends right after, and the run-end clear (an effect on `runningPaths`) would wipe them before the follow-up run publishes its own list; a carried-over state survives exactly one run end. Each request records the step current when it arrived (`PendingUiTool.stepId`).
- `devia_ask_user` answers survive in the transcript as `ds-question-answered-card`, keyed on the TOOL NAME via `isAskUserTool()` (`src/shared/domain/question-ask.ts`: `AskUserQuestion`, `mcp__devia-ui__devia_ask_user`, the old `mcp__devia-ask__…`, OpenCode's `devia-ui_devia_ask_user`) and by the rendezvous callId (`ui-<uuid>`), never the stream's `tool_use` id; `answerQuestion` re-keys its optimistic `tool_result` onto the run's latest unanswered question call (`transcriptQuestionId`). A finished run's question with no result still renders with "Respuesta no registrada".
- Plan mode contract (`claude-runner/infrastructure/plan-protocol.ts`): the plan-mode system prompt carries a MANDATORY protocol, not a hint: explore read-only → persist the plan on the kanban (one `kanban_create_spec`, one `kanban_create_task` per step with column `todo`, `dependsOn`, files/acceptance criteria/tests in the body; embeds `KANBAN_TOOLBOX` from `sdd/prepare/prompts.ts`) → `devia_plan_approve` (plain text with no card) → never implement. On "keep planning" the agent must update the existing spec/tasks, not create a duplicate.
- Header rule (S-43): the "no interactive UI in this run" header and the multi-turn footer appear ONLY when `ask_user` is missing; when it is available but other cards are not, the header is the neutral "Not available in this run" and `TOOL_LINES.ask_user` says to use it for any choice or approval.
- `buildRemoteProtocolHint(isRemote, filesReachable)` adds one "send it as a file" bullet. The `outbox/` fallback line (`buildUiFallbackHint`) appears only when `canSendFiles` but the tool was not delivered (relative path so the prompt stays cache-stable across worktrees); in plan mode it says files cannot be sent.
- Schema budget for `devia_send_file` (kept bare: `path`, `caption?`, `as?: auto|document|photo`): +438 chars on `tools/list`; plan mode keeps it on purpose (sending an existing file is read-only) under its own cap `planWithSendFile` 3 600.

- Adding a tool = a schema in `tool-registry.ts`, a case in `ds-ui-tool-host`'s `#cardList` plus its name in `CARD_TOOLS`, its name in `IMPLEMENTED_UI_TOOLS`, and its i18n keys; then update two test assertions (`wiredUiTools > drops a tool whose card has not landed yet` and `passes the advertised tool set to the server` in `run-instruction.use-case.test.ts`).
- `tools/list` payload budget is pinned by a test (apply ≈ 4.6 KB, cap 4 800; whole surface cap 5 500; plan with send_file cap 3 600).
- `trackedHandle.writeToolResult` is mounted whenever anything was delivered, because the answer travels by FILE, not by the agent's stdin.
- Design-token trap: cards must use real `--dv-*` names ([chat-ui.md](chat-ui.md)).

## Tests

`src/main/features/ui-tools/**/*.test.ts`, `src/shared/domain/ui-tools-policy.test.ts`, run-level tests in `run-instruction.use-case.test.ts`.

## Related

[../ui-tools/00-architecture.md](../ui-tools/00-architecture.md), [../ui-tools/release-notes.md](../ui-tools/release-notes.md), [claude-runner.md](claude-runner.md), [chat-ui.md](chat-ui.md), [../reference/mcp-servers.md](../reference/mcp-servers.md)
