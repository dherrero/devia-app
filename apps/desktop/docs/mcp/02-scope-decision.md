# Default scope of the MCP server manager (T-51)

## Problem

When a user opens the **right-rail MCP manager** with a project active
and installs a server, what should the default scope be?

Until this change, the modal defaulted to `global` regardless of context
because of a typo in `emptyForm()` (`projectPath === '' ? 'global' :
'global'`). Users reasonably expected "install for all my CLIs in this
project" → the server only appeared inside Devia (because the runner
already injects servers via `--mcp-config`), and was missing when they
opened the same CLI from a terminal in the project (because Devia
hadn't written it to `<project>/.mcp.json` either). T-50 fixed the
*global* paths so the global option works correctly, but the **default**
choice still wasn't what most users wanted.

## Decision

The modal now defaults the scope by context:

| Modal context                       | Default scope |
| ----------------------------------- | ------------- |
| Opened with an active project       | `project`     |
| Opened without an active project    | `global`      |

The user can always flip the radio button before pressing install.

## Why project as the default

1. **Least surprise**: "I'm in this project, I'm installing a tool for
   this project."
2. **Travels with the repo**: project-scope MCP entries land at
   `<project>/.mcp.json` (Claude), `<project>/.codex/config.toml`
   (Codex), `<project>/.gemini/settings.json` (Gemini), etc. The user
   can commit them so teammates inherit the same MCP environment.
3. **Doesn't pollute `$HOME`**: avoids growing `~/.claude.json` /
   `~/.codex/config.toml` with one-off servers used by a single repo.
4. **Reversible**: if the user actually wants a server for every
   project, they can flip to `global` in two clicks and the path tables
   (after T-50) write to the documented user-scope files for each CLI.

## Why not "write to both" automatically

We considered writing to both global and project-scope files when the
modal is opened with an active project (option C in the spec). Decided
against because:

- Duplicates configuration across two files; updates would have to keep
  them in sync and surface conflicts.
- The user sees the same server twice in `claude mcp list` / similar
  CLI inspectors and can't tell which one wins on a conflict.
- Adds a third "everywhere" scope on top of `global` / `project` —
  more UI surface for an edge case.

If a user wants both, they can install once with `project` and then
install again with `global`.

## Implementation

`apps/desktop/renderer/app/mcp/mcp-modal.component.ts` — two locations
updated to derive the default from `projectPath`:

- `emptyForm(projectPath)`: returns `scope: projectPath === '' ?
  'global' : 'project'`.
- `openCatalogInstall(entry)`: same rule (`this.data.projectPath !== ''
  ? 'project' : 'global'`).

The radio button copy stays as-is (`mcp.modal.scope_global` →
"Global (usuario)" / `mcp.modal.scope_project` → "Solo en este
proyecto"); no i18n key changes required.

## Out of scope (deferred)

- **Auto-dual scope toggle**: a checkbox "also install globally" on top
  of the radio. Would address users who really want both but is extra
  UI for a niche case; skipped until somebody asks.
- **Copilot project default**: copilot has no project-scope file
  (`resolveAgentTarget('copilot', 'project', …) === null` after T-50).
  When the user picks project scope for copilot, the synchroniser
  silently skips it. We may surface a "copilot installs globally
  regardless" hint in a future polish ticket.
