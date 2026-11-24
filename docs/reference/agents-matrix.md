# Agents matrix

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

Source of truth: `src/main/features/cli-adapters/infrastructure/defs/*.ts` (definitions), `src/main/features/agents/infrastructure/static-mapper-registry.ts` (mapper), `src/main/features/mcp/domain/agent-targets.ts` (MCP target), `src/main/features/skills/domain/agent-map.ts` (skills). 13 agents.

| id | Binary | Mapper | Stream format | System prompt | Continuity / resume | MCP delivery | Skills dir (project) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `claude` | `claude` | dedicated | `claude-stream-json` | `argv` (`--append-system-prompt`; frozen on resume → turn-context block) | native, `--resume` | per-run `--mcp-config` | `.claude/skills` |
| `codex` | `codex` | legacy | `json-event-stream` (codex parser) | `stdin-prepend` | native, `exec resume <id>` | `~/.codex/config.toml`, `.codex/config.toml` | `.agents/skills` |
| `gemini` | `gemini` | legacy | `json-event-stream` | `stdin-prepend` | `replay` (transcript re-seeded) | `~/.gemini/settings.json` | `.agents/skills` |
| `opencode` | `opencode-cli` | dedicated | `json-event-stream` | `stdin-prepend` | native, `--session <id>` | per-run `OPENCODE_CONFIG` | `.agents/skills` |
| `cursor-agent` | `cursor-agent` | legacy | `json-event-stream` | `stdin-prepend` | no resume args in the def (UNVERIFIED how context persists) | `~/.cursor/mcp.json` | `.agents/skills` |
| `copilot` | `copilot` | legacy | `json-event-stream` | `stdin-prepend` | no resume args in the def (UNVERIFIED) | `~/.copilot/mcp-config.json` | `.agents/skills` |
| `grok` | `grok` | legacy | `json-event-stream` (grok parser) | `argv-prepend` (inlined `[System]…[User]` in `-p`) | native, `--session <id>` | global `~/.grok/user-settings.json` (`mcp.servers[]`) | none (not in skills map) |
| `pi` | `pi` | dedicated | `pi-rpc` | `argv-file` (`--append-system-prompt <file>`) | native, `--session-id` | per-run `-e` extension | native `--skill <dir>` |
| `kimi` | `kimi` | ACP | `acp-json-rpc` | prepended to every `session/prompt` | `replay`, plan enforcement `none` (UNVERIFIED profile) | `session/new.mcpServers` | none |
| `hermes` | `hermes` | ACP | `acp-json-rpc` | prepended to every `session/prompt` | `replay` (verified on Hermes 0.23.0), plan enforcement `none` | `session/new.mcpServers` | none |
| `qwen` | `qwen` | legacy | `plain` | `stdin-prepend` | no resume args in the def | `~/.qwen/settings.json` | `.qwen/skills` |
| `qoder` | `qodercli` | legacy | `json-event-stream` (qoder parser) | `stdin-prepend` | no resume args in the def | none | `.qoder/skills` |
| `deepseek` | `deepseek` | legacy | `plain` | `unsupported` (startup assertion warns) | no resume args in the def | none | none |

Notes:

- Auth probes exist for claude, cursor-agent, gemini, opencode, grok (`infrastructure/detection/probe-*-auth.ts`); other agents have none.
- Mode flags per agent: [../features/run-modes.md](../features/run-modes.md). Native sub-agents: Claude (`--agents <file>`) and OpenCode (`agent` entries); everyone else via `devia_skill`.
- `McpAgentId` (agents with a native-config MCP target): claude, codex, gemini, opencode, cursor-agent, copilot, qwen, grok, pi. kimi/hermes use ACP `session/new`; qoder and deepseek get no MCP at all (a status notice is shown when the user configured servers).
- There is no `mimo` agent in this branch. Non-CLI providers (API, MCP, local model) are registered for visibility only and cannot be selected.
- User-defined agents (`agent-defs.json`): only `streamFormat: 'acp-json-rpc'` defs with an `acp` block get the ACP mapper; they cannot re-point a built-in id.

## Related

- [../features/cli-adapters.md](../features/cli-adapters.md), [../features/agents.md](../features/agents.md), [../architecture/agent-layers.md](../architecture/agent-layers.md)
