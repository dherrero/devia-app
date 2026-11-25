# CLI adapters (agent definitions, detection, launcher)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Static knowledge about each CLI agent (binary, models, flag builders, auth probe, prompt strategy), detection of what is installed, the spawn-only launcher, the legacy agents' stream parsers and error classification.

## Does

- `RuntimeAgentDef` (`src/main/features/cli-adapters/domain/runtime-agent-def.ts`): per-agent descriptor with `streamFormat` (`claude-stream-json`, `json-event-stream`, `pi-rpc`, `acp-json-rpc`, `plain`), `systemPromptStrategy` (`argv` | `argv-file` | `argv-prepend` | `stdin-prepend` | `unsupported`; required, a startup assertion warns on `unsupported`), `continuity` (`native` default, `replay` for Gemini), `buildExtraArgs` (mode-aware flags), `buildResumeArgs`, `authProbe`, `envOverrideKeys`, `maxPromptArgBytes`, `defaultDisallowedTools`, `buildRunFiles` (Gemini plan policy).
- Defs in `src/main/features/cli-adapters/infrastructure/defs/`: claude, codex, copilot, cursor-agent, deepseek, gemini, grok, hermes, kimi, opencode, pi, qoder, qwen. Table: [../reference/agents-matrix.md](../reference/agents-matrix.md).
- Detection (`infrastructure/detection/`): `ParallelAgentDetector`, PATH resolution, version probes, per-agent auth probes (`probe-claude-auth`, `probe-gemini-auth`, `probe-cursor-agent-auth`, `probe-opencode-auth`, `probe-grok-auth`); detection errors are stripped of host paths by `classifyDetectionError` before IPC.
- Launcher (`infrastructure/cli-launcher.ts`): spawns a `PreparedRun` only: binary, env (+ `PWD` = cwd), Windows command-line guards, watchdog, exit classification, `kill-tree.ts` (Windows `taskkill /T /F /PID`). It knows no prompt, system prompt or stream format.
- Legacy stream parsers (`infrastructure/parsers/`): codex, copilot, cursor-agent, gemini, grok, qoder event streams plus `plain-text.ts`; `select-parser.ts` picks by `eventParser`. Error matchers in `infrastructure/matchers/<agent>.matchers.ts`.
- Child environment (`buildSpawnEnv` in `src/main/features/cli-adapters/infrastructure/spawn-env.ts`): the parent `process.env` is inherited, then the def's env, then the mapper's `prepared.env` (user `agentCliEnv` values filtered by the def's `envOverrideKeys`), then trusted `agentEnv`; `PWD` is forced to the cwd and a stripped `ANTHROPIC_BASE_URL` is logged. User-supplied defs may only override keys matching `SAFE_ENV_KEY_PATTERN` (`*_API_KEY`, `*_BASE_URL`, `*_CONFIG_DIR`, `*_TOKEN`).
- Raw capture for parser diagnosis: `raw-stream-logger.ts` writes JSONL to `~/.devia-app/logs/agent-cli/<agentId>/` only when `IS_DEV` or `DEVIA_LOG_RAW_CLI=1` (size-capped, 7-day purge).
- Agent errors explained to the user (S-54, `infrastructure/explain/`): `explainError(cliId, classified, ctx)` turns a classified error into a `UserFacingError` (`src/shared/domain/user-facing-error.ts`: `code`, `variant`, `params`, fallback `title`/`cause`, typed `actions`, redacted `details`). One explainer per agent (`<agent>.explain.ts`; PI/OpenCode/Codex/Qwen/DeepSeek/Grok/Kimi/Hermes also fall back to the shared `provider-failure.ts`, which reads the provider JSON nested in the text through `nested-error.ts`); an agent without a reading, or any error it does not recognise, uses the reason-based `generic.ts`. `ExplainContext` (built by `claude-runner/application/error-context.ts`) carries the saved model, the NAMES of inherited provider key variables, the auto-continue switch, `resetsAt` and the run origin. `RunInstructionUseCase` attaches the result as `userError` to `error` stream events and to `process:end`; the raw text always travels beside it. The renderer shows it in `ds-agent-error-card` (translated by `agent_error.<code>.title|cause[_<variant>]`, es/en); Telegram gets the title and cause as plain text, and `actions` is empty for remote runs.
- Use cases: list agents, select agent (`SelectAgentUseCase` rejects non-CLI providers), set model/reasoning, set env, test agent.

## Does NOT

- Does NOT let non-CLI providers (API, MCP, local model) be the active agent: they are registered for visibility only.
- Does NOT own prompt/MCP/stream logic any more (moved to the mappers, [agents.md](agents.md)).
- Does NOT include a `mimo` agent: no def exists in this branch (spec S-23 did not land).
- Does NOT keep user-defined `env` for custom agent defs (dropped), nor let a custom def re-point a built-in id.
- Does NOT sanitise the inherited parent environment: the host `process.env` reaches the child (the default-deny `env-slicer` in the security feature is not wired in, see [security.md](security.md)).
- Does NOT retry or fall back to another agent on failure: the explanation only tells the user what to do.
- Explanations are verified against real agent logs for Claude (shapes from its decoder and matchers), PI and OpenCode (`~/.devia-app/logs/agent-cli/`). Codex, Gemini, Cursor, Copilot, Qwen, DeepSeek, Qoder, Grok, Kimi and Hermes have NO recorded failure logs: their rules come from their matcher tables (Kimi/Hermes: ACP "authentication required" conventions) and are UNVERIFIED against a live failure.
- Does NOT translate causes beyond es/en (S-27); other locales show the Spanish fallback text.
- OpenCode's `APIError` frame keeps its `statusCode` in the wire frame, but the decoder passes only the message text, so its explainer reads text, not the status.
- Codex has no OS sandbox on Windows, so `apply` falls back to full access there.

## Entry points

- `src/main/features/cli-adapters/index.ts:buildCliAdaptersFeature` — wiring (registry, detector, launcher)
- `src/main/features/cli-adapters/domain/runtime-agent-def.ts:RuntimeAgentDef` — def contract
- `src/main/features/cli-adapters/infrastructure/registry.ts` — def registry
- `src/main/features/cli-adapters/infrastructure/cli-launcher.ts` — spawn
- `src/main/features/cli-adapters/infrastructure/detection/agent-detector.ts:ParallelAgentDetector` — detection
- `src/main/features/cli-adapters/infrastructure/parsers/select-parser.ts` — parser selection
- `src/main/features/cli-adapters/infrastructure/error-classifier.ts` — error classes
- `src/main/features/cli-adapters/infrastructure/explain/index.ts:explainError` — user-facing error readings
- `src/renderer/app/features/chat/chat-panel/components/agent-error-card/` — the error card
- `src/main/features/cli-adapters/application/select-agent.use-case.ts:SelectAgentUseCase`
- `src/main/features/cli-adapters/ipc/cli-adapters.ipc.ts` — IPC

## IPC / MCP surface

- `agents:list`, `agent:select`, `agent:setModel`, `agent:setEnv`, `agent:test`, `agent:changed`.

## Persistence

- `devia-app.config.json` keys `agentId`, `agentModels`, `agentCliEnv`; user agents in `agent-defs.json`; raw logs under `~/.devia-app/logs/agent-cli/`.

## Config

`agentId`, `agentModels`, `agentCliEnv` (secrets masked in UI), effort per agent, `DEVIA_LOG_RAW_CLI`. See [../reference/config.md](../reference/config.md).

## Gotchas

- A multi-byte character can straddle two stdout chunks: every stream is decoded with a `StringDecoder`.
- Grok delivers the system prompt by inlining a `[System]…[User]` header in `-p` (`argv-prepend`), counted against `maxPromptArgBytes` (200 KB).
- Gemini 0.46 rejects the `__devia_managed` marker key in its MCP settings; the MCP target sets `jsonOmitMarker` (`src/main/features/mcp/domain/agent-targets.ts`).
- `grok` binary on PATH may be an old v1.0.1 without `--format json`; the parser falls back to plain text.

## Tests

- `src/main/features/cli-adapters/**/*.test.ts` (defs, parsers, launcher stdin, detection, `explain/*.test.ts`); `tools/agent-error-i18n.test.ts` (every code has es/en text); `tools/agent-e2e/` for real CLIs.

## Related

- [agents.md](agents.md), [claude-runner.md](claude-runner.md), [run-modes.md](run-modes.md), [security.md](security.md)
