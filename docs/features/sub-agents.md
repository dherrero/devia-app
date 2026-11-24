# Sub-agents manager

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Reusable sub-agent definitions kept in the project (`.devia/sub-agents/`) and synchronised to each CLI's native format.

## Does

- Install/remove write the definition into each selected CLI's native location (`resolveSubAgentTarget`, `src/main/features/sub-agents/domain/agent-targets.ts`): claude `.claude/agents/<name>.md`, cursor-agent `.cursor/agents/<name>.md`, gemini `.gemini/agents/<name>.md` (+ `.gemini/settings.json` companion), opencode `opencode.json` (json-merge), qwen `.qwen/commands/<name>.md` (slash command), copilot `.vscode/copilot-agents.json` (json-merge). Install/remove snapshot first ([snapshot.md](snapshot.md)).
- `AutoImportUseCase` runs on project open: copies every native sub-agent file it finds into `<project>/.devia/sub-agents/`, skipping files that already exist (re-entrant, no sentinel file). This repository's own agents (`.claude/agents/desktop-developer`, `qa-desktop`, `devia-safe-angular-implementer`) are imported this way.
- Delivery at run time: `HarnessCatalog` lists enabled sub-agents (parked = no `agents:` in the front-matter); Claude gets them natively via `--agents <file>`, OpenCode as `agent` entries in its per-run config, every other agent through `devia_skill` (a sub-agent loads as a role).
- UI: sub-agents modal (`src/renderer/app/features/sub-agents/sub-agents-modal.component.ts`).

## Does NOT

- Does NOT support codex and deepseek (no sub-agent surface): install is a no-op with a status message.
- Does NOT orchestrate sub-agents itself; only Claude has native sub-agent runtime and its calls render as nested cards ([agents.md](agents.md)).
- Does NOT sync definitions between projects automatically.

## Entry points

- `src/main/features/sub-agents/index.ts:buildSubAgentsFeature` — wiring
- `src/main/features/sub-agents/domain/agent-targets.ts:resolveSubAgentTarget`
- `src/main/features/sub-agents/application/install-sub-agent.use-case.ts:InstallSubAgentUseCase`
- `src/main/features/sub-agents/application/auto-import.use-case.ts`
- `src/main/features/sub-agents/infrastructure/sub-agent-writer.ts`
- `src/main/features/sub-agents/ipc/sub-agents.ipc.ts`
- `src/main/features/claude-runner/infrastructure/harness-catalog.ts:HarnessCatalog`

## IPC / MCP surface

- `subAgents:list`, `subAgents:install`, `subAgents:remove`, `subAgents:autoImport`, `subAgents:changed`.

## Persistence

`<project>/.devia/sub-agents/<name>.md` plus each CLI's native file.

## Config

None.

## Gotchas

- Front-matter `agents:` controls which CLIs a definition is installed for; empty means parked.

## Tests

`src/main/features/sub-agents/**/*.test.ts`.

## Related

[skills.md](skills.md), [agents.md](agents.md), [snapshot.md](snapshot.md)
