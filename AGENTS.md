# Agents

Single source of truth for how to work in this repository. `CLAUDE.md` is only a pointer back to this file.

## Product

Devia is an open-source (Apache-2.0) desktop client that drives CLI coding agents (Claude Code, Codex, Gemini CLI, OpenCode, Pi, and more) from a single window: chat, split-view sessions, kanban, memory, terminal, git, remote control. Everything runs locally.

## Layout

| Path            | What                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- |
| `apps/desktop`  | The app: Electron main (Node, CommonJS) + Angular 21 renderer. Full detail in `apps/desktop/AGENTS.md` |
| `libs/ui`       | `@devia/ui` — shared Angular components                                                  |
| `libs/styles`   | `@devia/styles` — design tokens and SCSS                                                 |

Nx workspace; run everything from the repository root. The landing site, the published Releases and `updates/latest.json` live in a separate repo, `dherrero/devia` (see `apps/desktop/AGENTS.md` → Distribution). Node `>=24.14.1` (see `.nvmrc`).

## Commands

```bash
npm install
npm run dev:desktop        # build + watch + Electron (run `npm run build:desktop` first after main-process changes)
npm run build:desktop
npm run typecheck:desktop  # does NOT compile Angular templates; build:desktop does
npm run test:desktop       # main (Vitest, node) + renderer (Vitest, jsdom)
npm run lint:desktop
npm run pack:desktop       # electron-builder for the current OS
```

## Conventions

- Read `apps/desktop/AGENTS.md` before touching the app: IPC model, features, security guards, agent layers.
- TypeScript strict, `exactOptionalPropertyTypes`. Angular: standalone, signals, OnPush, no NgModules.
- Comments only for non-obvious *why*. No secrets in the repo; never relax the security guards documented in `apps/desktop/AGENTS.md`.
- Update `apps/desktop/AGENTS.md` when you change something significant, and keep `CLAUDE.md` files as pointers only.

## Git workflow

GitHub Flow. Branches: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`. Never commit to `main` directly; do not bypass hooks. Pull requests need typecheck, build and tests green. See `CONTRIBUTING.md`.

## Language

- Code, comments, this file and `apps/desktop/AGENTS.md`: English.
- Community files (`README*`, `CONTRIBUTING.md`, `SECURITY.md`): English, with Spanish README as the original.
- UI strings live in `apps/desktop/renderer/assets/i18n/*.json`.
