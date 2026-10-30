/**
 * Per-project process bookkeeping. Owned by the `claude-runner` feature
 * because process lifecycle lives there, but consumed by:
 *   - workspace  → folder rename refuses if any descendant runs; trash
 *                  cascades stops to every descendant.
 *   - status     → enumerates running projects.
 *   - persistence→ snapshots state.projects to state.json.
 *
 * State carried per project: whether a child process is currently running,
 * which Devia session JSON file is active, and the agent-generated session ID
 * captured from the last successful run (used to pass --resume on next call).
 */
export interface ProjectRecord {
  readonly name: string;
  readonly isRunning: boolean;
  newSession: boolean;
  activeSessionId: string | null;
  /** Session ID emitted by the agent in its stream (session_started event).
   *  null until the agent confirms a session; never set by Devia itself. */
  agentSessionId: string | null;
  /** The agent id (`def.id`) that produced `agentSessionId`. Native session ids
   *  are agent-specific (a Claude session ≠ a Codex thread), so resume is only
   *  attempted when this matches the currently active agent — otherwise
   *  switching agents would `--resume`/`exec resume` an id the new agent never
   *  created ("No conversation found" / "no rollout found"). null when no
   *  agent session is stored. */
  agentSessionAgentId: string | null;
}

export interface ProjectRegistry {
  /** Returns the existing record or creates a fresh one and registers it. */
  getOrCreate(projectPath: string): ProjectRecord;
  /** Returns the existing record or undefined — never auto-creates. */
  find(projectPath: string): ProjectRecord | undefined;
  has(projectPath: string): boolean;
  delete(projectPath: string): void;
  /** Iteration order is insertion order. */
  entries(): IterableIterator<readonly [string, ProjectRecord]>;
  values(): IterableIterator<ProjectRecord>;
  paths(): string[];

  isRunning(projectPath: string): boolean;
  runningCount(): number;
  /** Stops a single project — no-op if not running or unknown. */
  stopProject(projectPath: string): void;
  stopAll(): string[];

  /**
   * Migrates state.projects keys after a folder rename. Every record whose
   * key matches `fromPath` or starts with `fromPath + '/'` is moved to the
   * corresponding key under `toPath`. Callers must verify no descendant is
   * running before calling this (folder-rename use case enforces it).
   */
  renamePrefix(fromPath: string, toPath: string): void;

  /** Drops every record matching `folderPath` or any descendant. */
  deletePrefix(folderPath: string): string[];
}
