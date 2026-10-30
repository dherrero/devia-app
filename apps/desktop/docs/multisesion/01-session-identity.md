# Session identity: worktreeDir-as-identity (S-13 T-145)

## Decision

**Identity = working directory of the run.**

`sessionKey(ref)` returns `ref.workdir`. For the primary session `workdir ===
baseProject`, so the key is the project path — identical to the current
single-session behaviour. No existing maps, queues, or registry entries change
shape.

## Why workdir, not a UUID or composite key

The backend is already keyed by path:

- `SessionRegistry` — `Map<projectPath, …>`
- `QueueService` — per-project queue indexed by path
- `runningPaths` Set
- `claude:output` IPC event carries `project` (a path)
- `GitWatcher`, `TerminalService`, `SessionsService` — all path-keyed

Switching to a pure UUID key would require migrating every consumer. Using
`workdir` as the key lets the primary-session path fall through unchanged and
adds isolation for additional sessions at zero migration cost.

## Lazy worktree creation policy

| Scenario | What happens |
|---|---|
| First (and only) session for a project | Agent runs directly in the project repo. No worktree is created. Behaviour identical to pre-S-13. |
| Second simultaneous session opened on the same project | A git worktree is created (T-150) and the session's `workdir` is set to that directory. |
| N-th simultaneous session | Same: one new worktree per additional session. |

Rationale: creating a worktree for the primary session would break the common
case — the user expects edits to appear in the real checkout, and a worktree
would hide them from git-status, commit, and diff tools that read the main
repo. The first session must stay in the repo.

## Sandbox mode (out of scope)

A future "sandbox mode" opt-in could create a worktree even for a single
session (safe experimentation without touching the real branch). This is
intentionally out of scope for S-13 and not wired here; the `SessionRef` type
is forward-compatible with it because `workdir` already decouples cwd from
`baseProject`.

## Types and helper (`shared/domain/session-ref.ts`)

```typescript
interface SessionRef {
  baseProject: string;   // canonical repo path
  sessionId:   string;   // stable panel/session uuid
  workdir:     string;   // cwd for the agent CLI run
  branch?:     string;   // worktree branch (additional sessions only)
}

function sessionKey(ref: SessionRef): string  // returns ref.workdir
function primarySessionRef(baseProject, sessionId): SessionRef  // workdir = baseProject
```

Field names align with `WorktreeRef { baseProject, sessionId, worktreeDir,
branch }` from T-150 so the two types compose without renaming.

## Consuming tickets

| Ticket | What to do |
|---|---|
| T-146 (re-key renderer state) | Replace bare `projectPath` keys in AppStateService maps/signals with `sessionKey(ref)`. `primarySessionRef` makes migration trivial for single-session paths. |
| T-150 (worktree cwd) | Implement `WorktreeRef` and set `SessionRef.workdir = worktreeRef.worktreeDir` when creating the 2nd+ session. |
| T-153 (run dispatch) | Pass `sessionKey(ref)` as the `project` field in `RunOptions` and IPC events so the main process routes output correctly. |
