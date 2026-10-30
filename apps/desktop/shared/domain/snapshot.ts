/**
 * Cross-process domain types for the Snapshot / rollback feature (#270).
 *
 * Snapshot stores an idempotent, dedup'd copy of config files BEFORE a
 * destructive write (skill install/remove, MCP register, prompt-pack
 * inject, spec-kit init). One-click restore reverts every file in the
 * snapshot back to its captured state.
 *
 * On-disk layout (each snapshot is fully self-contained):
 *
 *   ~/.devia-app/snapshots/<feature>/<id>/
 *     manifest.json     ← SnapshotManifest below
 *     files/
 *       0.gz            ← gzip(content of files[0])
 *       1.gz
 *       …
 *
 * Why per-file gzip instead of one tar.gz:
 *  - Zero npm dependency (devia avoids heavy file packers — gentle-ai
 *    uses tar but we don't want to pull in node-tar for what amounts
 *    to a handful of small config files).
 *  - Restore is trivial: read manifest, gunzip each numbered blob,
 *    write to its absolute path. No streaming/parsing of a tar layout.
 *  - Dedup is per-snapshot, not per-file, so the storage win of tar
 *    sharing inner offsets is irrelevant here.
 */

/** Feature that produced the snapshot — used for grouping in the UI
 *  and the retention sweep ("keep last N per feature"). */
export type SnapshotFeature =
  | 'skills'
  | 'mcp'
  | 'prompt-packs'
  | 'manual';

export interface SnapshotEntry {
  /** Absolute path of the original file on disk. */
  readonly path: string;
  /** True when the file existed at snapshot time. False entries are
   *  preserved so restore can re-delete a file the destructive op
   *  created (e.g. a fresh `.specify/` after `specify init`). */
  readonly existed: boolean;
  /** SHA-256 of the captured content, hex-encoded. Used for the
   *  per-snapshot fingerprint + the restore drift detector. Missing
   *  when `existed: false`. */
  readonly sha256?: string;
  /** Captured size in bytes. Missing when `existed: false`. */
  readonly size?: number;
  /** Relative path inside `files/` where the gzipped blob lives.
   *  Missing when `existed: false` (nothing to compress). */
  readonly archiveName?: string;
}

export interface SnapshotManifest {
  readonly id: string;
  /** ms-resolution Unix timestamp. */
  readonly createdAt: number;
  readonly feature: SnapshotFeature;
  /** Short human-readable explanation surfaced in the history UI.
   *  Example: `skills:install "docs-writer" for claude+codex`. */
  readonly reason: string;
  /** Project the operation belonged to, when applicable. Global-scope
   *  ops (e.g. MCP server registered for the user) omit it. */
  readonly projectPath?: string;
  readonly entries: ReadonlyArray<SnapshotEntry>;
  /** Total SHA-256 of the concatenated entry checksums — drives the
   *  dedup: two consecutive create() calls with identical input
   *  return the same id instead of writing a redundant snapshot. */
  readonly fingerprint: string;
  /** User flag protecting this snapshot from the retention sweep. */
  readonly pinned: boolean;
}

/** Renderer-facing summary. Same shape as the manifest but with the
 *  entries collapsed to a count so the history list stays small. */
export interface SnapshotSummary {
  readonly id: string;
  readonly createdAt: number;
  readonly feature: SnapshotFeature;
  readonly reason: string;
  readonly projectPath?: string;
  readonly fileCount: number;
  readonly pinned: boolean;
}

/** Restore result — entries split into clean restores, drift skips and
 *  hard failures so the renderer can show a precise summary. */
export interface SnapshotRestoreResult {
  readonly restored: ReadonlyArray<string>;
  /** Files the user modified after the snapshot was taken. Restore
   *  refused to overwrite them without a force flag. */
  readonly drift: ReadonlyArray<{ path: string; currentSha256: string; snapshotSha256: string }>;
  readonly failed: ReadonlyArray<{ path: string; error: string }>;
}

export interface CreateSnapshotRequest {
  readonly feature: SnapshotFeature;
  readonly reason: string;
  /** Absolute paths to snapshot. Non-existent paths are recorded so
   *  restore can re-delete them. */
  readonly paths: ReadonlyArray<string>;
  readonly projectPath?: string;
}

export interface CreateSnapshotResult {
  readonly id: string;
  /** True when an existing snapshot with the same fingerprint was
   *  reused instead of writing a fresh one. */
  readonly deduped: boolean;
}

export interface ListSnapshotsQuery {
  readonly feature?: SnapshotFeature;
  readonly projectPath?: string;
  /** Cap the number of summaries returned (default 50). */
  readonly limit?: number;
}
