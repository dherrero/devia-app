# Skill registry

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Generates a per-project index of installed skills so the agent can lazy-load the ones it would never know about.

## Does

- `BuildSkillRegistryUseCase` renders a deterministic Markdown table of project plus global skills, project-wins dedup by name, writes it idempotently (skips a write when the body matches) and adds the registry dir to the project's `.gitignore` on first generation; deletes a stale file when the skill count drops to zero.
- `SkillRegistryWatcher` regenerates on project switch and file-system ticks; IPC offers status, refresh, watch and read; `skillRegistry:changed` notifies the renderer.
- The runner appends a ~340-char pointer to the registry (`buildSkillRegistryHint`, `src/main/shared/skill-registry-hint.ts`) to the system prompt, not a listing.

## Does NOT

- Does NOT generate an empty registry for a project without skills.
- Measured during S-25: replacing the hint with `devia_skill` does not pay off, so both exist.

## Entry points

- `src/main/features/skill-registry/index.ts:buildSkillRegistryFeature` — wiring
- `src/main/features/skill-registry/application/build-registry.use-case.ts:BuildSkillRegistryUseCase`
- `src/main/features/skill-registry/infrastructure/skill-registry-writer.ts` — deterministic renderer
- `src/main/features/skill-registry/infrastructure/skill-registry-watcher.ts`
- `src/main/features/skill-registry/ipc/skill-registry.ipc.ts`
- `src/main/shared/skill-registry-hint.ts:buildSkillRegistryHint`

## IPC / MCP surface

- `skillRegistry:status`, `skillRegistry:refresh`, `skillRegistry:watch`, `skillRegistry:changed`, `skillRegistry:read`.

## Persistence

`<project>/.devia/skill-registry.md` (gitignored by Devia).

## Config

None.

## Gotchas

- The writer must stay deterministic (no timestamps, stable sort), or the watcher loops.

## Tests

`src/main/features/skill-registry/**/*.test.ts`, `src/main/shared/skill-registry-hint.test.ts`.

## Related

[skills.md](skills.md), [ui-tools.md](ui-tools.md)
