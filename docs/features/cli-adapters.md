# CLI adapters (agent definitions, detection, launcher)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Static knowledge about each CLI agent (binary, models, flag builders, auth probe, prompt strategy), detection of what is installed, the spawn-only launcher, the legacy agents' stream parsers and error classification.

## Does

- `RuntimeAgentDef` (`src/main/features/cli-adapters/domain/runtime-agent-def.ts`): per-agent descriptor with `streamFormat` (`claude-stream-json`, `json-event-stream`, `pi-rpc`, `acp-json-rpc`, `plain`), `systemPromptStrategy` (`argv` | `argv-file` | `argv-prepend` | `stdin-prepend` | `unsupported`; required, a startup assertion warns on `unsupported`), `continuity` (`native` default, `replay` for Gemini), `buildExtraArgs` (mode-aware flags), `buildResumeArgs`, `authProbe`, `envOverrideKeys`, `maxPromptArgBytes`, `defaultDisallowedTools`, `buildRunFiles` (Gemini plan policy).
- Defs in `src/main/features/cli-adapters/infrastructure/defs/`: claude, codex, copilot, cursor-agent, deepseek, gemini, grok, hermes, kimi, opencode, pi, qoder, qwen. Table: [../reference/agents-matrix.md](../reference/agents-matrix.md).
- Model lists: a def with `listModels` gets its picker filled from the CLI at detection (`opencode models`, `pi --list-models`: only the providers the CLI has credentials for, so a provider missing from the list is not logged in inside that CLI); otherwise, or when the command fails or yields nothing, the def's `fallbackModels` are used. pi's table is parsed by `parsePiModels` (`src/main/features/cli-adapters/infrastructure/defs/pi.ts`).
- Detection (`infrastructure/detection/`): `ParallelAgentDetector`, PATH resolution, version probes, per-agent auth probes (`probe-claude-auth`, `probe-gemini-auth`, `probe-cursor-agent-auth`, `probe-opencode-auth`, `probe-grok-auth`); detection errors are stripped of host paths by `classifyDetectionError` before IPC.
- Launcher (`infrastructure/cli-launcher.ts`): spawns a `PreparedRun` only: binary, env (+ `PWD` = cwd), Windows command-line guards, watchdog, exit classification, `kill-tree.ts` (Windows `taskkill /T /F /PID`). It knows no prompt, system prompt or stream format.
- Legacy stream parsers (`infrastructure/parsers/`): codex, copilot, cursor-agent, gemini, grok, qoder event streams plus `plain-text.ts`; `select-parser.ts` picks by `eventParser`. Error matchers in `infrastructure/matchers/<agent>.matchers.ts`.
- Child environment (`buildSpawnEnv` in `src/main/features/cli-adapters/infrastructure/spawn-env.ts`): the parent `process.env` is inherited, then the def's env, then the mapper's `prepared.env` (user `agentCliEnv` values filtered by the def's `envOverrideKeys`), then trusted `agentEnv`; `PWD` is forced to the cwd and a stripped `ANTHROPIC_BASE_URL` is logged. User-supplied defs may only override keys matching `SAFE_ENV_KEY_PATTERN` (`*_API_KEY`, `*_BASE_URL`, `*_CONFIG_DIR`, `*_TOKEN`).
- Raw capture for parser diagnosis: `raw-stream-logger.ts` writes JSONL to `~/.devia-app/logs/agent-cli/<agentId>/` only when `IS_DEV` or `DEVIA_LOG_RAW_CLI=1` (size-capped, 7-day purge).
- Use cases: list agents, select agent (`SelectAgentUseCase` rejects non-CLI providers), set model/reasoning, set env, test agent.
- Effective agent (S-53), priority **session > project > global**. `config.agentId` is the global default. `resolveEffectiveAgentId` (`src/shared/domain/effective-agent.ts`) applies the priority and falls back one level, reporting `fellBackFrom`, when a level names an agent that is not an installed CLI provider.
- `createEffectiveAgentResolver` (`src/main/shared/effective-agent-resolver.ts`) is the single main-process answer. Runs (`RunInstructionUseCase`), Telegram, the queue, auto-continue, the handoff auxiliary client and starter-kit detection use it, so none can disagree with the footer. With no session id it uses the project's active session (the primary pane).
- `SetContextAgentUseCase` sets or clears (`agentId: null`) the agent of a project (`scope: 'project'`, stored as `ProjectRecord.preferredAgentId`) or of a session (`scope: 'session'`). It refuses unknown or non-CLI agents and any change while that pane runs (`AGENT_RUN_ACTIVE`). `GetEffectiveAgentUseCase` answers the renderer.
- Footer: the agent chip opens `AgentPickerComponent` (`src/renderer/app/layout/statusbar/agent-picker/`). The target is the project, or the session for an additional split pane or a pane whose session already has its own agent (`AppStateService.agentTarget`). Settings › Execution chooses the global default.

## Does NOT

- Does NOT let non-CLI providers (API, MCP, local model) be the active agent: they are registered for visibility only.
- Does NOT pin the global agent onto a project at its first prompt: a project without `preferredAgentId` follows the global default, so changing the default moves every such project.
- Does NOT keep model, effort or env per project: they stay per agent (`agentModels[agentId]`).
- Does NOT let the agent change under a running instruction, and does NOT translate the picker texts outside `es` and `en`.
- Does NOT own prompt/MCP/stream logic any more (moved to the mappers, [agents.md](agents.md)).
- Does NOT include a `mimo` agent: no def exists in this branch (spec S-23 did not land).
- Does NOT keep user-defined `env` for custom agent defs (dropped), nor let a custom def re-point a built-in id.
- Does NOT sanitise the inherited parent environment: the host `process.env` reaches the child (the default-deny `env-slicer` in the security feature is not wired in, see [security.md](security.md)).
- Codex has no OS sandbox on Windows, so `apply` falls back to full access there.

## Entry points

- `src/main/features/cli-adapters/index.ts:buildCliAdaptersFeature` — wiring (registry, detector, launcher)
- `src/main/features/cli-adapters/domain/runtime-agent-def.ts:RuntimeAgentDef` — def contract
- `src/main/features/cli-adapters/infrastructure/registry.ts` — def registry
- `src/main/features/cli-adapters/infrastructure/cli-launcher.ts` — spawn
- `src/main/features/cli-adapters/infrastructure/detection/agent-detector.ts:ParallelAgentDetector` — detection
- `src/main/features/cli-adapters/infrastructure/parsers/select-parser.ts` — parser selection
- `src/main/features/cli-adapters/infrastructure/error-classifier.ts` — error classes
- `src/main/features/cli-adapters/application/select-agent.use-case.ts:SelectAgentUseCase`
- `src/main/features/cli-adapters/application/set-context-agent.use-case.ts:SetContextAgentUseCase`
- `src/main/features/cli-adapters/application/get-effective-agent.use-case.ts:GetEffectiveAgentUseCase`
- `src/main/shared/effective-agent-resolver.ts:createEffectiveAgentResolver`
- `src/main/shared/session-agent-index.ts:SessionAgentIndex`
- `src/shared/domain/effective-agent.ts:resolveEffectiveAgentId`
- `src/main/features/cli-adapters/ipc/cli-adapters.ipc.ts` — IPC

## IPC / MCP surface

- `agents:list`, `agent:select`, `agent:setModel`, `agent:setEnv`, `agent:test`, `agent:changed`; S-53: `agents:set-context-agent` (invoke), `agents:effective` (invoke), `agents:effective-changed` (event; no fields = the global default changed, every project must ask again).

## Persistence

- `devia-app.config.json` keys `agentId`, `agentModels`, `agentCliEnv`; user agents in `agent-defs.json`; raw logs under `~/.devia-app/logs/agent-cli/`.
- Project agent: `state.json` → `projects[<project>].preferredAgentId` (optional; omitted when unset). Session agent: `preferredAgentId` inside `session-<uuid>.json` ([sessions.md](sessions.md)).

## Config

`agentId` (the global default agent), `agentModels`, `agentCliEnv` (secrets masked in UI), effort per agent, `DEVIA_LOG_RAW_CLI`. See [../reference/config.md](../reference/config.md).

## Gotchas

- A multi-byte character can straddle two stdout chunks: every stream is decoded with a `StringDecoder`.
- Grok delivers the system prompt by inlining a `[System]…[User]` header in `-p` (`argv-prepend`), counted against `maxPromptArgBytes` (200 KB).
- Gemini 0.46 rejects the `__devia_managed` marker key in its MCP settings; the MCP target sets `jsonOmitMarker` (`src/main/features/mcp/domain/agent-targets.ts`).
- `grok` binary on PATH may be an old v1.0.1 without `--format json`; the parser falls back to plain text.
- A session agent chosen for a pane that has no session on disk yet is held in memory by `SessionAgentIndex` and written by that session's first save (`SaveChatUseCase`); a pane closed without running leaves nothing behind, and the choice is lost if the app quits before that first save.
- Handoff summaries precomputed for split-pane keys use the global agent's auxiliary client (the base project is unknown there); the run's own handoff uses the session agent.
- Changing a project's or session's agent makes its native session foreign: the next run starts a fresh native session with the handoff brief ([session-handoff.md](session-handoff.md)); it never resumes another agent's id.

## Tests

- `src/main/features/cli-adapters/**/*.test.ts` (defs, parsers, launcher stdin, detection, effective agent use cases); `src/main/shared/effective-agent-resolver.test.ts`, `src/main/shared/session-agent-roundtrip.test.ts`; `tools/agent-e2e/` for real CLIs.

## Related

- [agents.md](agents.md), [claude-runner.md](claude-runner.md), [run-modes.md](run-modes.md), [security.md](security.md)
