# Starter kits (Devia Method)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Delivers the Devia Method, Devia's own development method (skills + bootstrap prompt), to every agent through Devia's harness, never by writing into the user's repository or home.

## Does

- The kit is `resources/kits/devia-method/` (`kit.json`, `skills/`, `.claude-plugin/plugin.json` with no hooks, `LICENSE`, generated `UPSTREAM.md` and `VERSION.json`), packaged through `build.extraResources` into `<resources>/kits` (outside the asar because it holds executable scripts). `npm run vendor:upstream`, `npm run kit:build`, `npm run check:kits`, `npm run kit:upstream-diff -- --tag vX` maintain it.
- Materialised once per version into `<deviaDir>/kits/devia-method/<tag>-<hash>/` with read-only files and kept-executable scripts; refused if it no longer matches its pin; older versions pruned.
- Gating (`StarterKitsPort.resolve`): `config.starterKits['devia-method'] = { enabled, projects[baseCheckout], introSeen }`. A fresh install seeds ON; an existing install is never switched silently (first-run card `ds-starter-kit-intro` asks); a per-project override wins. It steps aside for an agent that already has a development method installed (`native-detector.ts`, names in `third-party-methods.ts`).
- Delivery: the core appends `kit.prompt` (bootstrap skill `using-devia` plus a one-line index of the others, ~4.4 KB) to the system prompt of EVERY agent, serves `<kit>/skills` last through `devia_skill` (a project's or user's skill of the same name wins), adds `harness.kit`/`readDirs` and puts the kit dir in `extraAllowedDirs`. Claude also loads the kit as a plugin (`--plugin-dir`) for its native Skill tool.
- Plan mode: with the method active `METHOD_PLAN_PROTOCOL` replaces the plan protocol's ordering with `brainstorming` → approved design → ONE `kanban_create_spec` → `writing-plans` → plan card.
- State lives on the kanban, not in files ([sdd.md](sdd.md)); the only scratch files are review packages and test logs in `<repo>/.devia/review/` (self-ignoring).
- Gemini receives a per-run `--policy` file (in `<deviaDir>/tmp`) allowing `devia-kanban`/`devia-memory`/`devia-ui` in plan mode and denying `exit_plan_mode`; OpenCode gets `permission.external_directory` for `readDirs`; pi gets `--tools +bash,+edit,+write` outside plan mode.
- UI: Settings → Devia Method (`ds-settings-starter-kit-section`, applies immediately via `starter-kits:status|set`) and the first-run intro card.

## Does NOT

- Does NOT include a Devia-native SDD orchestrator, an embedded visual preview, remote kit updates, exporting a spec/plan to the repository, or a Devia-native session diagnosis (S-39 backlog).
- Does NOT run when another development method is already installed for that agent.
- Does NOT create, move or remove worktrees: `isolating-work` / `finishing-work` leave them to Devia (split panes and delegated workers). With a single agent and no pane, the agent creates its own `feat/<slug>` or `fix/<slug>` branch from `dev`/`develop` (gitflow) or `main`/`master` (githubflow); push, PR and merge still need an explicit request.
- Executing a plan needs `apply-yolo` for Claude (`apply` is `acceptEdits`, which a headless run cannot extend to Bash).
- Behaviour evals (`tools/agent-e2e/evals.cjs`) cost money and never run in CI.

## Entry points

- `src/main/features/starter-kits/index.ts:buildStarterKitsFeature` — wiring and IPC
- `src/main/features/starter-kits/infrastructure/kit-materializer.ts:materializeKit`
- `src/main/features/starter-kits/domain/kit-prompt.ts:buildKitPrompt`
- `src/shared/domain/starter-kit.ts` — settings, `resolveKitEnabled`
- `resources/kits/devia-method/kit.json` — manifest
- `src/main/features/claude-runner/infrastructure/plan-protocol.ts` — `METHOD_PLAN_PROTOCOL`
- `src/renderer/app/layout/starter-kit/starter-kit-intro.component.ts` — intro card

## IPC / MCP surface

- `starter-kits:status`, `starter-kits:set`.

## Persistence

`~/.devia-app/kits/devia-method/<tag>-<hash>/`; `config.starterKits`.

## Config

`config.starterKits['devia-method']`.

## Gotchas

- Never edit a copied (`literal`) kit file by hand: `check:kits` fails; make it `own` in `kit.json`.
- Skills of the kit are `stable` prompt material: toggling the kit mid-session takes effect only in a new session.
- Directories stay writable on purpose (a read-only tree breaks `rm -rf ~/.devia-app`).
- Rules that each came out of a failed run are listed in [../devia-method/02-agents.md](../devia-method/02-agents.md).

## Tests

`src/main/features/starter-kits/kit-lint.test.ts`, `src/main/features/starter-kits/kit-ask-rule.test.ts`, `src/main/features/starter-kits/starter-kits.test.ts`, `tools/no-upstream-name.test.ts`, `tools/vendor-upstream.test.ts`; real-agent evals under `tools/agent-e2e/`.

## Related

[../devia-method/00-audit.md](../devia-method/00-audit.md), [../devia-method/01-design.md](../devia-method/01-design.md), [../devia-method/02-agents.md](../devia-method/02-agents.md), [sdd.md](sdd.md), [run-modes.md](run-modes.md), [skills.md](skills.md)
