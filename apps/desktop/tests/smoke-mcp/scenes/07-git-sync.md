# Scene 07 — Git status pills (HT-ST-02)

Verifies the statusbar surfaces the new ahead/behind/changedCount
fields. Requires a project with a real git remote — the smoke uses the
`devia` repo itself as a fixture.

## Setup
- Workspace pointed at the parent dir of `devia`.
- Select the `devia` project.

## Steps

1. `mcp__electron__electron_wait_for_selector`
   `ds-statusbar .group dv-icon` (the git branch icon).
2. `mcp__electron__electron_query_text_by_selector`
   - selector: `ds-statusbar .group:nth-of-type(2)`
   - expect: contains the current branch name.
3. Make a quick uncommitted edit (touch a file via the shell or the
   right-rail terminal). After the watcher fires:
4. `mcp__electron__electron_wait_for_selector`
   `.git-changes`.
5. `mcp__electron__electron_query_text_by_selector`
   `.git-changes` → expect `1 cambios` (or `N cambios`).
6. `git checkout -- .` to revert.
7. `mcp__electron__electron_wait_for_function`
   `() => !document.querySelector('.git-changes')`.

## Cleanup
- Ensure the working tree is clean before exiting.
