/**
 * Devia internal memory domain types (Phase 1).
 *
 * Persisted at:
 *   personal scope → <deviaDir>/memory-global.json
 *   project scope  → <deviaDir>/projects/<key>/memory.json
 *
 * All timestamps are epoch milliseconds (number). No Node.js or
 * Electron imports — this file must be safe to import from both main
 * and renderer processes.
 */

export type MemoryScope = 'project' | 'personal';

export type MemoryObservationType =
  | 'decision'
  | 'architecture'
  | 'bugfix'
  | 'pattern'
  | 'config'
  | 'discovery'
  | 'learning'
  | 'manual';

/** A single persisted memory observation. */
export interface Observation {
  /** Internal id: `obs-<seq>`. Stable after creation. */
  readonly id: string;
  /** Engram sync_id, when imported from engram. */
  readonly syncId?: string;
  /** Id of the session during which this observation was created. */
  readonly sessionId: string;
  readonly type: MemoryObservationType;
  title: string;
  content: string;
  /** Workspace-relative or absolute project path this observation belongs to. */
  readonly project?: string;
  readonly scope: MemoryScope;
  /** Freeform topic key for grouping related observations. */
  readonly topicKey?: string;
  /** MCP tool name that triggered this observation, when applicable. */
  readonly toolName?: string;
  /** CLI agent id ('claude', 'codex', …) that wrote this observation (S-2 F1.1). */
  readonly agentId?: string;
  /** Epoch ms. */
  readonly createdAt: number;
  /** Epoch ms — updated on every content edit. */
  updatedAt: number;
  /** Epoch ms. Set when soft-deleted; absent when active. */
  deletedAt?: number;
  /** When true, this observation is exempt from store size-cap eviction. */
  pinned?: boolean;
}

/** A Devia chat or agent session during which observations were made. */
export interface MemorySession {
  /** Internal id: `ses-<seq>`. */
  readonly id: string;
  /**
   * External run/session id (e.g. the runner's active session). Lets a real
   * session map to a single record across turns via upsert (E-DSK-13 #318);
   * absent on legacy/manual sessions.
   */
  readonly sessionId?: string;
  readonly project: string;
  readonly directory: string;
  /** CLI agent id that drove this session (S-2 F1.1). */
  agentId?: string;
  /** Epoch ms. */
  readonly startedAt: number;
  /** Epoch ms. Absent when session is still open. */
  endedAt?: number;
  summary?: string;
  /**
   * True when Devia auto-captured this session summary passively from the run
   * lifecycle (E-DSK-13 phase C). Such sessions are excluded from system-prompt
   * pre-injection (phase A) so the recalled feed stays dominated by the agent's
   * own richer `mem_session_summary` entries; they remain available to search.
   */
  auto?: boolean;
  /**
   * 'handoff' marks a cross-agent handoff record (S-2 F2.2). Handoffs are NOT
   * auto (they must enter recall/search) and are appended as their own record:
   * the upsert-by-sessionId path skips them so a later run summary for the
   * same session never overwrites the handoff entry.
   */
  kind?: 'handoff';
}

/** A user prompt saved for context / recall. */
export interface UserPromptRecord {
  /** Internal id: `prm-<seq>`. */
  readonly id: string;
  readonly sessionId: string;
  readonly content: string;
  readonly project?: string;
  /** CLI agent id active when this prompt was recorded (S-2 F1.1). */
  readonly agentId?: string;
  /** Epoch ms. */
  readonly createdAt: number;
}

/**
 * Top-level JSON document persisted on disk.
 *
 * One document per (scope, projectPath) pair. The personal-scope
 * document lives at `<deviaDir>/memory-global.json`; a project-scope
 * document lives at `<deviaDir>/projects/<key>/memory.json`.
 */
export interface MemoryStoreDoc {
  readonly version: 1;
  readonly scope: MemoryScope;
  /** Absolute project path — present only for `scope === 'project'`. */
  readonly projectPath?: string;
  sessions: MemorySession[];
  observations: Observation[];
  prompts: UserPromptRecord[];
  /** Monotonic counter for observation id minting. */
  nextObsSeq: number;
  /** Monotonic counter for session id minting. */
  nextSessionSeq: number;
  /** Monotonic counter for prompt id minting. */
  nextPromptSeq: number;
}

/** Input for lexical search over observations. */
export interface MemorySearchQuery {
  query: string;
  type?: MemoryObservationType;
  project?: string;
  scope?: MemoryScope;
  limit?: number;
}

/** A single search result with relevance score. */
export interface MemorySearchHit {
  observation: Observation;
  /** Higher is more relevant. Driven by token-overlap scoring. */
  score: number;
}

/** A compact observation projection for system-prompt injection (E-DSK-13 #314). */
export interface MemoryRecallObservation {
  type: MemoryObservationType;
  title: string;
  content: string;
}

/**
 * Hybrid, task-aware recall for pre-injection (E-DSK-13 #314): observations
 * relevant to the current prompt (highest relevance first) plus recent session
 * summaries for continuity. Pure data — the formatter turns it into the block.
 */
export interface MemoryRecall {
  observations: MemoryRecallObservation[];
  summaries: string[];
}

// ── Engram detection / import result types ────────────────────────────────
// Declared here (not in src/main) so shared/contracts/devia-bridge.ts can
// reference them without importing from the main process.

export interface EngramDetectionResult {
  present: boolean;
  hasBinary: boolean;
  hasDb: boolean;
  /** Resolved absolute path of the engram binary if found. */
  binPath?: string;
  /** Absolute path to the engram.db file that was checked. */
  dbPath?: string;
}

export type ImportEngramError =
  | { ok: false; reason: 'engram-binary-missing' }
  | { ok: false; reason: 'engram-export-timeout' }
  | { ok: false; reason: 'engram-export-failed'; stderr: string }
  | { ok: false; reason: 'engram-parse-error'; message: string };

export interface ImportEngramSuccess {
  ok: true;
  imported: number;
  skipped: number;
  sessions: number;
  prompts: number;
}

export type ImportEngramResult = ImportEngramSuccess | ImportEngramError;
