# Code Mode (S-50)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Lets an agent write ONE short TypeScript script that calls the user's MCP servers inside a sandbox, so only the value the script `return`s reaches the context.

## Does

- Scope: only MCP servers the user added in the manager with `exposure: 'codemode'`. Devia's own servers (`devia-memory`, `devia-kanban`, `devia-ui`, `devia-code-graph`) are NEVER put behind a script (`DEVIA_SERVER_IDS` in `application/plan-code-mode.ts`).
- The switch: "Installed" tab selector Direct / Via code mode per server → IPC `mcp:set-exposure` → `SetMcpExposureUseCase` (re-installs with the credentials the registry holds).
- Two places a server reaches an agent, both must agree: native config (`InstallMcpUseCase` skips a `codemode` server for every agent where `isCodeModeAgent()` is true and removes what an earlier sync left via `removedIds`) and per run (`planCodeMode()`, called from `RunInstructionUseCase`, takes `codemode` servers out of `harness.mcp.user` and adds the gateway to `harness.mcp.devia`; returns null when nothing moves, so other runs are byte-identical; if the mapper will not deliver the gateway the servers are put back as ordinary ones).
- `isCodeModeAgent` (`src/main/features/code-mode/domain/code-mode-agents.ts`): claude, codex, gemini, opencode, cursor-agent, copilot, qwen. pi has its own native code mode and is left alone; grok and the ACP agents keep their servers direct.
- Gateway `devia-code-mode` (`mcp-server/server.ts`, child of the agent over stdio, no SDK; args `--servers-file <abs.json> [--events-dir <abs>]`): tools `search_tools(query?, server?)`, `get_types(servers[])`, `run_script(code, description?)`. The servers file is `<deviaDir>/tmp/code-mode/<runId>/servers.json` (mode 0600, carries credentials) and is deleted when the run ends, fails or the gateway is not delivered (6 h sweep as safety net).
- `run_script`: the code is the body of an async function (top-level `await`/`return`); `checkScript` type-checks it against declarations generated from the servers' JSON Schemas BEFORE running (a type error costs nothing); servers without `outputSchema` return `any`; then it runs in QuickJS compiled to WASM (`infrastructure/sandbox.ts`) with only `tools` and `console.log` as globals; each run gets its OWN WASM module (an out-of-memory abort kills the module).
- Limits (`DEFAULT_LIMITS`, `DEFAULT_POLICY_BUDGETS`): 50 s wall clock, 64 MB, 32 KB returned, 200 calls (100 per tool), 8 concurrent.
- Policy (`application/bridge.ts`, the only door out of the sandbox): v1 scripts only READ; a tool without `readOnlyHint: true` is denied in every mode (`ToolDeniedError`, code `TOOL_DENIED`) without calling the server; `stats.denied` exposes swallowed denials; `decide()` is the single place a later phase widens.
- Chat: the gateway appends `CodeModeEvent`s to `<runDir>/events/<scriptId>.jsonl`; `CodeModeEventRelay` turns them into ordinary `tool_use`/`tool_result` events with `parentToolUseId` = the agent's `run_script` call (matched by a hash of the code); `ToolCallCardComponent` renders header (servers · calls · time), result, nested calls, code, failure kinds and an estimate of tool data kept out of context (4 bytes/token, shown above ~500 tokens).

## Does NOT

- Does NOT allow writes from scripts (saved macros and batched-approval writes are backlog T-558, T-559).
- Does NOT touch Devia's own four servers or enterprise-managed config: with `managed-mcp.json` Claude takes no injected server.
- Does NOT apply to grok or ACP agents (direct only until verified).
- Per-CLI MCP tool-call timeouts were NOT measured live (only pi/Codex's 60 s are known).
- Codex `exec` cancels MCP calls under a managed sandbox on apply (openai/codex#16685), which hits the gateway like any MCP server.
- Has no network, filesystem, process or timer access inside the sandbox.

## Entry points

- `src/main/features/code-mode/index.ts:buildCodeModeFeature` — wiring
- `src/main/features/code-mode/application/plan-code-mode.ts:planCodeMode` — per-run partition
- `src/main/features/code-mode/application/bridge.ts` — policy and budgets
- `src/main/features/code-mode/application/code-mode-event-relay.ts:CodeModeEventRelay`
- `src/main/features/code-mode/infrastructure/sandbox.ts` — QuickJS
- `src/main/features/code-mode/infrastructure/script-checker.ts` — type check
- `src/main/features/code-mode/infrastructure/mcp-client-pool.ts:McpClientPool`
- `src/main/features/code-mode/infrastructure/ts-libs.ts` — bundled TypeScript libs
- `src/main/features/code-mode/mcp-server/server.ts` — gateway process
- `src/main/features/code-mode/domain/code-mode-agents.ts:isCodeModeAgent`
- `src/shared/domain/code-mode.ts` — events
- `src/shared/domain/code-mode-summary.ts:summarizeScript` — card summary

## IPC / MCP surface

- MCP tools `search_tools`, `get_types`, `run_script`; IPC `mcp:set-exposure`.

## Persistence

`<deviaDir>/tmp/code-mode/<runId>/servers.json` and `events/*.jsonl` (per run, removed afterwards).

## Config

`McpServerConfig.exposure`.

## Gotchas

- Packaging: electron-builder's `!**/*.ts` rule also strips every `.d.ts`, so the installed app had no `typescript/lib/lib.*.d.ts` and every script failed type checking with "Cannot find global type 'Promise'" (invisible in dev). `scripts/copy-assets.cjs` writes the needed libs to `dist/.../code-mode/infrastructure/ts-libs.json` (57 files, ~485 KB) and `checkScript` serves ONLY those when the file exists. Verify packaging changes with `npm run pack:dir` and run the packaged gateway with `ELECTRON_RUN_AS_NODE=1`.
- Re-installing a server keeps its exposure.
- `quickjs-emscripten` and `typescript` are runtime `dependencies` for this feature.

## Tests

Unit tests per piece under `src/main/features/code-mode/**`, run-level tests in `src/main/features/claude-runner/application/run-instruction.use-case.test.ts` ("code mode gateway", "code mode events and cleanup"), install tests in `src/main/features/mcp/application/install-mcp.use-case.test.ts`; real agents: `node tools/agent-e2e/run.cjs claude --scenario codemode` (also `opencode`) with `tools/agent-e2e/stores-mcp.cjs`.

## Related

[mcp.md](mcp.md), [chat-ui.md](chat-ui.md), [../reference/mcp-servers.md](../reference/mcp-servers.md)
