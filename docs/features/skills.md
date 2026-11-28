# Skills manager

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Discover, install, list and remove agent skills (`SKILL.md` folders) from GitHub or local sources, linked into each agent's own skills directory.

## Does

- Install pipeline owned by Devia (it replaces the old `npx skills` wrapper): `SkillDiscoverer` clones the source into an OS temp dir and scans every directory containing a `SKILL.md` for a multi-select picker (`skills:discover`; the temp dir is registered under a `discoveryId`, consumed by the following install or freed by `skills:cancel-discovery`); `SkillInstaller` copies each picked skill into `~/.devia-app/skills/<key>/<name>/` (one copy per owner/repo/skill shared by every project) and symlinks it (junction on Windows, copy as fallback) into each selected agent's directory.
- Per-agent directories (`SKILL_AGENT_MAP`, `src/main/features/skills/domain/agent-map.ts`): claude `.claude/skills` (global `~/.claude/skills`); codex, gemini, opencode, cursor-agent, copilot share the project dir `.agents/skills` with global `~/.codex/skills`, `~/.gemini/skills`, `~/.config/opencode/skills`, `~/.cursor/skills`, `~/.copilot/skills`; qwen `.qwen/skills`; qoder `.qoder/skills`.
- `SkillReader` lists project and global skills with the agents each is installed for; `RemoveSkillUseCase` removes them. Installs and removals snapshot first ([snapshot.md](snapshot.md)).
- Every agent reaches the skills through `devia_skill` ([ui-tools.md](ui-tools.md)); `HarnessCatalog` reads every agent's project and global skill dirs. Claude additionally loads `.claude/skills` natively; pi gets `--skill <dir>` per skill.
- UI: Skills modal (`src/renderer/app/features/skills/skills-modal.component.ts`, `modals.skills.*`).

## Does NOT

- Does NOT support deepseek (no documented skills support): install/remove are no-ops there; kimi, hermes and pi are not in `SKILL_AGENT_MAP`.
- Does NOT need `npx` or network after the first clone of a source.
- Does NOT version skills or update them automatically.
- Qwen and Qoder use vendor-specific dirs only: a skill must be installed twice to appear under both families.

## Entry points

- `src/main/features/skills/index.ts:buildSkillsFeature` — wiring
- `src/main/features/skills/domain/agent-map.ts:SKILL_AGENT_MAP`
- `src/main/features/skills/infrastructure/skill-discoverer.ts` — clone and scan
- `src/main/features/skills/infrastructure/skill-installer.ts` — install/remove engine
- `src/main/features/skills/infrastructure/skill-reader.ts` — listing
- `src/main/features/skills/ipc/skills.ipc.ts`
- `src/shared/domain/skill.ts` — types

## IPC / MCP surface

- `skills:list`, `skills:install`, `skills:remove`, `skills:discover`, `skills:cancel-discovery`.

## Persistence

`~/.devia-app/skills/<key>/<name>/` (cache) plus symlinks/copies in agent dirs.

## Config

None.

## Gotchas

- Prompt injection hardening: skill/frontmatter parsing and the symlink guard (`lstat` + `isSymbolicLink`) are shared with the prompt-pack scanner.
- Skill frontmatter parser: `src/main/shared/skill-frontmatter.ts`.

## Tests

`src/main/features/skills/**/*.test.ts`.

## Related

[skill-registry.md](skill-registry.md), [sub-agents.md](sub-agents.md), [mcp.md](mcp.md), [snapshot.md](snapshot.md)
