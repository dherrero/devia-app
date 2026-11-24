# Agents (per-agent mappers)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

One mapper per agent behind the `AgentMapper` port (S-30), so the run core stays agent-agnostic. A mapper translates an `AgentRunPlan` into argv/stdin/env/temp files and decodes the CLI's stream into canonical `AgentEvent`s.

## Does

- `AgentMapper` contract (`src/main/features/agents/domain/agent-mapper.ts`) in two phases: `resolveDelivery(plan)` (what reaches the agent and by which channel: `native` | `devia` | `none`) → core composes the prompt → `prepareRun(plan, systemPrompt, delivery)` → after spawn `openSession(io)` decodes the stream and owns ONE answer channel `answer(callId, AgentAnswer)`. Also `disallowedTools(mode)`, `harnessSupport`, `isolatesExternalMcp`, `freezesSystemPrompt`.
- `StaticMapperRegistry` (`src/main/features/agents/infrastructure/static-mapper-registry.ts`) picks: `DEDICATED_MAPPERS` first (claude, pi, opencode), then `AcpMapper` for a def with `streamFormat: 'acp-json-rpc'` AND an ACP profile, else `LegacyMapper`.
- Dedicated mappers: `agents/claude/` (wire.ts, decoder.ts, mapper.ts, subagents.ts), `agents/pi/` (rpc-driver.ts, pi-mcp-extension.ts), `agents/opencode/` (decoder.ts, run-config.ts). Each has golden tests over `__fixtures__/` recorded from the real CLI.
- ACP (Agent Client Protocol of Zed, JSON-RPC over stdio) through one generic `AcpMapper` (`agents/acp/`) on the official SDK `@agentclientprotocol/sdk` pinned at 1.9.0. Profiles: `agents/acp/profiles/{hermes,kimi,custom}.ts`. User-defined ACP agents come from `agent-defs.json` (`acp` block).
- `LegacyMapper` (`agents/infrastructure/legacy/`) keeps the pre-S-30 behaviour byte-for-byte (`legacy-mapper.equivalence.test.ts`) for codex, gemini, cursor-agent, copilot, grok, qwen, qoder, deepseek.
- Shared building blocks (`agents/shared/`): `def-invocation.ts`, `stream-session.ts`, `native-config-mcp.ts` (ONE native-config write per run, `prune: false`), `json-lines.ts`.
- Harness delivery per agent: Claude per-run `--mcp-config` (+ grants, `--strict-mcp-config`), skills via `.claude/skills` + `devia_skill`, sub-agents via native `--agents <file>`; pi per-run `-e` extension (`registerMcpServer`) + native `--skill <dir>`; OpenCode per-run `OPENCODE_CONFIG` + native `agent` entries; ACP `session/new.mcpServers` (stdio) + `devia_skill`; legacy agents get Devia's servers in their native config + `devia_skill`.
- Sub-agents in the chat (S-49): Claude emits `parent_tool_use_id` lines and `system/task_*` lifecycle; the decoder maps them to `tool_use.parentToolUseId` and `{type:'subagent', …}` events; the renderer nests child calls in the parent's tool card. Fixtures: `agents/claude/__fixtures__/subagent*.jsonl`.
- Per-turn context (S-40): Claude Code ≥ 2.1.310 keeps the first turn's system prompt and ignores a new `--append-system-prompt` on resume, so for a mapper with `freezesSystemPrompt = true` (Claude only) volatile parts go in a `<devia-turn-context source="devia" priority="binding">` block delivered as the FIRST text block of the stream-json user message; resent on first turn, hash change, compaction or native-session-id change (`TurnContextTracker`).
- Usage events: `inputTokens` EXCLUDES cache; context fill = `inputTokens + cachedInputTokens` of the LAST request (Claude uses `usage.iterations[-1]` and `modelUsage[<model>]`).
- Rate limit: the Claude decoder turns `rate_limit_event` / the synthetic limit message into an `AgentEvent` `rate_limit` ([auto-continue.md](auto-continue.md)).

## Does NOT

- Does NOT give every agent its own mapper: only claude, pi, opencode are dedicated; ACP covers kimi and hermes; the other eight run on `LegacyMapper` (phase 2 of S-30 is spec S-31, mostly backlog).
- Does NOT serve `fs` or `terminal` to ACP agents (announced `false`; calls get JSON-RPC "method not found") and does not forward MCP `http`/`sse` servers to them. No persistent ACP connection manager; an ACP `plan` update only becomes a `status` line.
- Does NOT implement `qwen-acp` (flag and capabilities unverified); Kimi runs an UNVERIFIED `replay`/`none` profile.
- pi plan mode is `--tools read,grep,find,ls,mcp__*` (pi has no permission modes); OpenCode stays cwd-confined (no per-path flag).
- Only Claude emits sub-agent events; other agents have no native sub-agents.
- Grok's MCP config is GLOBAL (`~/.grok/user-settings.json`): concurrent grok runs of two projects can race on `--project`.

## Entry points

- `src/main/features/agents/domain/agent-mapper.ts:AgentMapper` — port
- `src/main/features/agents/domain/agent-run-plan.ts` — `AgentRunPlan`
- `src/main/features/agents/infrastructure/static-mapper-registry.ts:DEDICATED_MAPPERS` — selection
- `src/main/features/agents/claude/mapper.ts` — Claude mapper
- `src/main/features/agents/claude/decoder.ts` — Claude decoder
- `src/main/features/agents/pi/rpc-driver.ts` — pi RPC driver
- `src/main/features/agents/opencode/mapper.ts` — OpenCode mapper
- `src/main/features/agents/acp/mapper.ts:AcpMapper` — ACP
- `src/main/features/agents/acp/permissions.ts` — ACP permission policy
- `src/main/features/agents/infrastructure/legacy/legacy-mapper.ts` — legacy path

## IPC / MCP surface

None directly (consumed by the run core). Tool names are normalised: pi sanitises `mcp__<server>__<tool>`; the driver restores ids (`normalizePiToolName`).

## Persistence

Per-run configs in `<deviaDir>/tmp/`, owner-only, removed after the run. Fixtures in `__fixtures__/`.

## Config

`agent-defs.json` (user-defined agents, `streamFormat: 'acp-json-rpc'` only gets ACP; `bin` must be a bare PATH name, `env` dropped), `agentId`, `agentModels`, effort settings. See [../reference/agents-matrix.md](../reference/agents-matrix.md).

## Gotchas

- The Claude session importer drops the `<devia-turn-context>` block from imported user messages (`src/shared/domain/claude-transcript.ts`). A literal copy of the tag in the user's text is escaped (`src/shared/domain/turn-context-tags.ts`). Known limits: the starter kit and skill registry are `stable`, so toggling them mid-session only applies to a new session; the block is dropped silently if a freezing mapper's def is not stream-json (only Claude freezes, and it is). Delivery is recorded when the model's first real event arrives (a `status`/`session_started` is not enough); a failed resume invalidates the session; a restart resends once.
- Before declaring `freezesSystemPrompt` for an agent, verify whether the CLI keeps its first prompt on resume (two runs of one session with different marker words in the system prompt; ask which marker it sees). pi 1.3.0 does NOT freeze.

- pi: the turn ends on `agent_settled`, NOT `agent_end`; MCP goes through a per-run extension (never `.pi/mcp.json`, which pi reads only in trusted projects); continuity is native via `--session-id`; stdout decoded with `StringDecoder`.
- ACP permissions: plan mode rejects `edit/delete/move/execute` (devia MCP tools exempt); a remote (Telegram) run NEVER auto-approves; apply-yolo selects the broadest allow option on desktop only. Hermes in plan mode still writes through its `terminal` tool, so `AcpMapper` adds a guard section to the prompt plus a closing reminder when `planEnforcement` is `none`.
- ACP SDK 2.x removed `ClientSideConnection`; do not bump past 1.9.0 without porting.
- OpenCode resolves its project from the `PWD` env var, not cwd: the launcher sets `PWD` = cwd.
- Adding an agent: record fixtures with `tools/agent-e2e` → `wire.ts` → decoder + golden test → `mapper.ts` → register in `DEDICATED_MAPPERS` → snapshot in the harness.
- The renderer keys on `mcp__devia-ui__…` tool names; any mapper must emit canonical names.

## Tests

- Agent E2E harness (`tools/agent-e2e/`, README there): drives real Claude / pi / OpenCode (and, free of charge, the scripted `acp-fake` ACP agent) through the real pipeline (headless composition over `dist/main`), four scenarios (apply, resume, plan, harness); snapshots split into `wiring` (what reached the CLI, must not change) and `behaviour` (model-dependent, warns). Costs money, never in CI. grok is excluded: its MCP config is GLOBAL, so sandbox `HOME` in anything that delivers to grok.
- Per-turn-context guards: `run-instruction.use-case.test.ts` ("S-40" describes) pins that nothing volatile reaches a frozen `stable` prompt; `tools/agent-e2e/turn-context-eval.cjs` measures that the model obeys the block against a contradictory frozen prompt (10/10 on haiku and sonnet; costs money, never CI).
- ACP layout: `profile.ts` (`AcpAgentProfile`, `ACP_PROFILES`), `connection.ts` (`AcpConnection`, `webStreamsFromChild`), `event-map.ts`, `permissions.ts`, `session.ts` (`openAcpSession`), `mapper.ts`, `testing/` (scriptable fake agent). Adding an ACP agent: verify against the real CLI with a minimal client (launch flag, `agentCapabilities`, mode ids, MCP tool naming, auth, whether it freezes instructions on resume); record fixtures; add a profile in `agents/acp/profiles/<id>.ts` and register in `ACP_PROFILES` (unverified fields stay `continuity: 'replay'`, `planEnforcement: 'none'` with an `unverified` comment); add a def in `cli-adapters/infrastructure/defs/` deriving `buildArgs`/`continuity` from the profile with `systemPromptStrategy: 'stdin-prepend'`; tests with the fake agent; a scenario in `tools/agent-e2e`; when in doubt ship a parallel `<agent>-acp` id until validated.

- `src/main/features/agents/**` golden decoder tests, `legacy-mapper.equivalence.test.ts`, `static-mapper-registry.test.ts`; `tools/agent-e2e/` real-agent harness (costs money, never CI).

## Related

- [claude-runner.md](claude-runner.md), [cli-adapters.md](cli-adapters.md), [mcp.md](mcp.md), [../architecture/agent-layers.md](../architecture/agent-layers.md), [../reference/agents-matrix.md](../reference/agents-matrix.md)
