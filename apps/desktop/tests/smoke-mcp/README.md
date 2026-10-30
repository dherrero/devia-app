# Electron smoke playbook (HT-QA-02)

This is the lightweight, manual-but-scripted smoke check for the Devia
desktop app. It uses the **Electron MCP** server to drive the running
binary the same way a human would — clicking buttons, switching themes,
toggling panels. Each "scene" below is a self-contained sequence of MCP
tool calls; running them all green means the build hasn't regressed any
of the core flows.

Why not Playwright? The visual regression suite (HT-QA-01) covers
deterministic screenshot diffs against the *renderer* alone. This
playbook is for things you can only check against the *whole app*:
IPC roundtrips, native window chrome, file dialogs, the right-rail
terminal, drag-and-drop and the splitter geometry. The MCP harness
spawns the production Electron binary, so the assertions actually
prove end-to-end behaviour.

## How to run

1. Build the desktop app: `npm run build:desktop`.
2. Start the app via `npm run start:desktop`.
3. Tell the agent: "run the desktop smoke playbook" — it loads each
   scene from `scenes/`, executes the MCP calls in order, and stops on
   the first scene that fails.

For ad-hoc checks during development, paste the scene script into the
agent's chat (each scene is a self-contained MD/JSON block) and it'll
replay it interactively.

## Scenes

| Scene                              | Covers                                    |
| ---------------------------------- | ----------------------------------------- |
| `01-theme-switcher.md`             | Titlebar pill switcher (HT-C-02 / HT-TB-01) |
| `02-sidebar-collapse.md`           | Ctrl+B sidebar collapse + drag splitter   |
| `03-send-message.md`               | Compose → send → streaming response       |
| `04-mode-bar.md`                   | Plan / Apply / YOLO switching             |
| `05-queue-pause-resume.md`         | Queue enqueue + pause + reorder           |
| `06-right-rail-tabs.md`            | Toggle terminal / tree / docker           |
| `07-git-sync.md`                   | Sync button states (clean / behind)       |
| `08-settings-open-close.md`        | Settings modal opens and persists         |

Each scene is **self-checking**: it asserts via DOM queries through
`mcp__electron__electron_query_visible_by_selector` etc., so a stale
window or a missing button surfaces immediately.

## Adding a scene

```md
# Scene NN — short title

## Setup
- Project: <fixture project path or "none">

## Steps
1. `mcp__electron__electron_click_by_text` "Templates"
2. `mcp__electron__electron_wait_for_selector` `.dsm-bases-editor`
3. `mcp__electron__electron_query_text_by_selector` `.dsm-bases-editor h2`
   → expect "Editar plantillas"

## Cleanup
- Press Escape to dismiss
- (optional) `mcp__electron__electron_clear_storage`
```

Keep each scene under 10 steps. Long sequences belong in a separate
"e2e" suite — this one is for fast smoke.
