# Settings and shell chrome

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

The Settings modal, the titlebar, themes, language, zoom and the other shell surfaces (sidebar, status bar, right rail, toasts).

## Does

- Settings modal (`src/renderer/app/features/settings/settings-modal/settings-modal.component.ts`) uses the master-detail `ModalShellComponent` (`src/renderer/app/shared/components/modal-shell/`). Sections (ids): `workspace`, `execution`, `appearance`, `memory`, `starter-kit`, `ui-tools`, `remote-control`. Section components live in `.../settings-modal/components/settings-*-section`.
- Execution section: agent selection (main-process rejections surfaced), per-agent model/effort, env vars (secrets masked `••••••••`), the "Auto-continue sessions" switch, and the import affordance per agent ([session-import.md](session-import.md)).
- Other dialogs opened from `AppComponent` (`src/renderer/app/app.component.ts`): workspace picker (`workspace-modal`), templates editor (`bases-editor-modal`, `writeBasesJson`, independent save), status modal (`status-modal`), snapshot history ([snapshot.md](snapshot.md)), MCP / skills / sub-agents / kanban / code-graph surfaces ([mcp.md](mcp.md), [skills.md](skills.md), [sub-agents.md](sub-agents.md), [sdd.md](sdd.md), [code-graph.md](code-graph.md)).
- Titlebar (`src/renderer/app/layout/titlebar/titlebar.component.ts`): a theme switcher and a kebab menu with Status, Stop all processes, a zoom control (out / reset / in, `devia.renderer.zoom`), Edit templates and Settings. On Windows/Linux it renders its own window controls; macOS uses the native traffic lights.
- Themes: four values `light`, `dark`, `navy`, `navy-dark` (family violet/navy × mode light/dark) in `localStorage('devia.theme')`, default `light`; corner style `rounded` | `sharp` (`devia.style`). `ThemeService.setTheme(family, mode)` is the single mutation point.
- Language: 11 files in `src/renderer/assets/i18n/` (`ar ca de en es fr hi it pt ru zh`); `SUPPORTED_LANGUAGES` is the Settings list, default `en`, OS locale detected until the user picks one, persisted as `language` ([../reference/i18n.md](../reference/i18n.md)).
- Layout surfaces: sidebar (projects, pins, sessions, search; `src/renderer/app/layout/sidebar/`), status bar with git chip, branch switcher entry, agent chip and token meter, right rail with project tree and docker panel, toasts, upgrade toast, splash, starter-kit intro card.
- Keyboard shortcuts service (`src/renderer/app/core/layout/keyboard-shortcuts.service.ts`, e.g. `Mod+J` terminal).

## Does NOT

- Does NOT offer the eight accent palettes older docs mentioned: the theme model is the four values above.
- Does NOT fall back to English for missing keys: `@ngx-translate` renders the raw key path.
- Does NOT keep AGENTS.md's old claim that the titlebar is "a single settings gear" (the code has the kebab menu above).
- Does NOT use a pro/paywall flow: `src/renderer/app/features/pro/` and the upgrade toast exist, but `shell:open-upgrade` only opens a URL when `DEVIA_SAAS_URL` is set (see [shell.md](shell.md)).

## Entry points

- `src/renderer/app/app.component.ts:AppComponent` — shell, dialogs, first-run prompts
- `src/renderer/app/features/settings/settings-modal/settings-modal.component.ts:SettingsModalComponent`
- `src/renderer/app/layout/titlebar/titlebar.component.ts:TitlebarComponent`
- `src/renderer/app/core/theme/theme.service.ts:ThemeService`
- `src/renderer/app/core/i18n/supported-languages.ts:SUPPORTED_LANGUAGES`
- `src/renderer/app/core/i18n/i18n.service.ts:I18nService`
- `src/renderer/app/core/zoom/renderer-zoom.service.ts`
- `src/renderer/app/layout/statusbar/statusbar.component.ts` — footer
- `src/renderer/app/layout/sidebar/sidebar.component.ts` — sidebar

## IPC / MCP surface

- `config:get`, `config:set`, `config:changed`, `status:get`, `bases:*`, `window:minimize`, `window:toggle-maximize`, `window:close`, `window:is-maximized`, `app:version`.

## Persistence

`devia-app.config.json` (workspace, agents, language, memory, remoteControl, uiTools, starterKits…), `window-state.json` (bounds + maximized), browser localStorage for theme, style, zoom and prompt flags.

## Config

See [../reference/config.md](../reference/config.md).

## Gotchas

- All user-visible strings go through `| translate`; i18n keys must be present in all 11 files or the raw key shows (parity gate: `tools/i18n-parity.test.ts`).
- Components are standalone, OnPush, signals only; colours come from `--dv-*` tokens in `src/renderer/styles.scss`.
- Spellcheck is on (`webPreferences.spellcheck`), with a custom context menu (`src/main/shell/context-menu.ts`) because Electron has none; opt a field out with `spellcheck="false"`.

## Tests

- `src/renderer/app/features/settings/settings-modal/settings-modal.component.spec.ts`, `src/renderer/app/core/theme/*.spec.ts`, `tools/i18n-parity.test.ts`.

## Related

- [chat-ui.md](chat-ui.md), [workspace.md](workspace.md), [../reference/config.md](../reference/config.md), [../reference/i18n.md](../reference/i18n.md)
