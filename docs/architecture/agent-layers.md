# Agent layers: render ↔ core ↔ mappers ↔ CLI (S-30)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

```
renderer ──[A: shared/contracts + AgentEvent]──▶ core (claude-runner) ──[B: AgentMapper]──▶ agents/<id> ──[C: wire.ts]──▶ CLI
```

Each agent is treated independently; the core is agent-AGNOSTIC.

- **Contract A** (`src/shared/contracts/`, `src/shared/domain/agent-event.ts`): canonical `AgentEvent`s (`text_delta`, `tool_use`, `usage`, `thinking`, `rate_limit`, `context_compacted`, `subagent`, `status`, …).
- **Core** (`src/main/features/claude-runner/application/`): decides WHAT a run needs and builds an `AgentRunPlan` (`src/main/features/agents/domain/agent-run-plan.ts`). `core-is-agent-agnostic.test.ts` fails on any agent-id literal or concrete-mapper import there. `RunInteraction` owns every user-facing card of a run.
- **Contract B** (`src/main/features/agents/domain/agent-mapper.ts`): `resolveDelivery(plan)` → core composes the prompt → `prepareRun(plan, systemPrompt, delivery)` → `openSession(io)` + `answer(callId, AgentAnswer)`; plus `disallowedTools(mode)`, `harnessSupport`, `isolatesExternalMcp`, `freezesSystemPrompt`.
- **Mappers** (`src/main/features/agents/<id>/`): `mapper.ts`, `wire.ts` (contract C: typed JSONL/RPC), decoder, golden tests over `__fixtures__/` recorded from the real CLI. Dedicated: claude, pi, opencode. ACP agents (kimi, hermes, user-defined) run on the generic `AcpMapper`; every other def runs on `LegacyMapper`.
- **Launcher** (`src/main/features/cli-adapters/infrastructure/cli-launcher.ts`): spawns a `PreparedRun` (binary, env + `PWD` = cwd, Windows guards, watchdog, exit classification); knows no prompt or stream format.

## Harness delivery (MCP, skills, sub-agents)

Everything managed in Devia reaches whichever agent is active; the CLI's own config is not the source of truth. `HarnessCatalog` lists skills and enabled sub-agents; `devia_skill` serves both to any agent.

| Agent | MCP | Skills | Sub-agents |
| --- | --- | --- | --- |
| Claude | per-run `--mcp-config` (+ grants, `--strict-mcp-config`) | `.claude/skills` + `devia_skill` | native `--agents <file>` |
| pi | per-run `-e` extension (`registerMcpServer`) | native `--skill <dir>` each | `devia_skill` |
| OpenCode | per-run `OPENCODE_CONFIG` (never the repo's `opencode.json`) | `.agents/skills` + `devia_skill` | native `agent` entries in the per-run config |
| ACP agents | `session/new.mcpServers` (stdio) | `devia_skill` | `devia_skill` |
| legacy agents | Devia's servers in their native config | `devia_skill` | `devia_skill` |

Per-run configs live in `<deviaDir>/tmp/`, owner-only, removed after the run. A user server's tokens must never be written into the user's repository.

## Does NOT

- Does NOT let the core ask which agent it is.
- Does NOT cover phase 2 of S-30 (own mappers for the remaining eight legacy agents; spec S-31 mostly backlog).

## Related

- [../features/agents.md](../features/agents.md), [../features/claude-runner.md](../features/claude-runner.md), [../features/cli-adapters.md](../features/cli-adapters.md), [../reference/agents-matrix.md](../reference/agents-matrix.md)
