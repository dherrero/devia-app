/**
 * Cross-CLI sub-agent manager domain (#275).
 *
 * Sub-agents are specialised agent prompts (a Markdown body + small
 * frontmatter) that the orchestrator delegates to for specific
 * tasks. Each CLI has its own native location and format:
 *
 *   Claude        .claude/agents/<name>.md          Markdown + frontmatter
 *   Cursor        .cursor/agents/<name>.md          Markdown + frontmatter
 *   Gemini        .gemini/agents/<name>.md          Experimental flag
 *   OpenCode      opencode.json > agent.<name>      JSON entry
 *   Qwen          .qwen/commands/<name>.md          Slash-command Markdown
 *   Copilot       .vscode/copilot-agents.json       JSON merge
 *   Codex/DS      —                                 Solo-agent, no-op
 *
 * Devia owns a single source of truth at
 * `<project>/.devia/sub-agents/<name>.md` and a synchroniser writes
 * the right format/path for each selected CLI. Marker-based merging
 * preserves hand-edited entries across syncs.
 */

/** CLI ids that may host a sub-agent. Mirrors the table in the spec. */
export type SubAgentCliId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'cursor-agent'
  | 'copilot'
  | 'qwen';

/** CLIs without any native sub-agent surface. Selecting them in the
 *  matrix renders the chip as locked + an explanatory tooltip. */
export const SUB_AGENT_UNSUPPORTED: ReadonlySet<SubAgentCliId> = new Set([
  'codex', // solo-agent
]);

/**
 * Parsed sub-agent from a `.devia/sub-agents/<name>.md` (or an
 * imported native dir file). All fields beyond name+body are
 * optional; missing fields fall back to safe defaults at the
 * synchroniser side.
 */
export interface SubAgent {
  /** File-stem matching slug — also the `name` in the frontmatter. */
  readonly name: string;
  /** Free-form description for the trigger / catalog UI. */
  readonly description: string;
  /** Tool names the sub-agent may use, in the Claude convention.
   *  Empty array means "inherit the parent's toolset". */
  readonly tools: ReadonlyArray<string>;
  /** Optional model override (Claude alias or full model id). */
  readonly model?: string;
  /** Optional maxTurns from the Claude frontmatter — surfaced for
   *  agents that honour it (Claude, Cursor); ignored elsewhere. */
  readonly maxTurns?: number;
  /** When `true`, the sub-agent must be writable to no files (Cursor
   *  has a first-class `readonly` flag for this; we propagate it
   *  through the writer). */
  readonly readonly?: boolean;
  /**
   * Devia source of truth: which CLIs to materialise for. Empty
   * array → the sub-agent is parked (kept in `.devia/sub-agents/`
   * but synced nowhere). Default at import time = the set of CLIs
   * the file was found under.
   */
  readonly agents: ReadonlyArray<SubAgentCliId>;
  /** Markdown body (without the frontmatter block). */
  readonly body: string;
}

/** Renderer-facing summary. */
export interface SubAgentView {
  readonly name: string;
  readonly description: string;
  readonly tools: ReadonlyArray<string>;
  readonly agents: ReadonlyArray<SubAgentCliId>;
  readonly model?: string;
  readonly readonly?: boolean;
  /** Absolute path of the canonical `.devia/sub-agents/<name>.md`. */
  readonly sourcePath: string;
}

/** Result of an install / remove call. */
export interface SubAgentInstallResult {
  readonly ok: boolean;
  /** Absolute paths the synchroniser touched (sub-agent files
   *  written or deleted). Empty when no work was needed. */
  readonly affectedFiles: ReadonlyArray<string>;
  /** Snapshot id from the snapshot feature (#270) when wired. */
  readonly snapshotId?: string;
  /** CLI ids that were silently skipped because they don't support
   *  sub-agents (codex, deepseek). The renderer surfaces this as
   *  an info chip rather than an error. */
  readonly skipped?: ReadonlyArray<SubAgentCliId>;
  readonly error?: string;
}

/** Result of the project-open auto-import. */
export interface SubAgentImportResult {
  readonly imported: ReadonlyArray<string>;
  /** True when the sentinel `.imported` file was already present and
   *  no work was done. */
  readonly skipped: boolean;
}

/** Bundled curated catalog entry — embedded in the renderer (no
 *  remote fetch in Phase 1). */
export interface SubAgentCatalogEntry {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tools: ReadonlyArray<string>;
  readonly defaultAgents: ReadonlyArray<SubAgentCliId>;
  readonly body: string;
}

/** Streamed when the project's sub-agent list changes. */
export interface SubAgentListChangedEvent {
  readonly projectPath: string;
  readonly subAgents: ReadonlyArray<SubAgentView>;
}
