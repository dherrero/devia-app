/**
 * Cross-process domain types for the Skill Registry feature (#269).
 *
 * The registry is a per-project index of every SKILL.md the agent could
 * load — across the project tree (`.agents/skills/`, `.claude/skills/`,
 * `.cursor/skills/`, …) and the user's global agent skill roots. It is
 * persisted as a Markdown file at `<project>/.devia/skill-registry.md`
 * so the agent can read it as plain context and lazy-load matching
 * SKILL.md files on demand.
 *
 * Why a separate feature instead of folding into `skills/`:
 *  - `skills/` is the install/list/remove pipeline (write-side).
 *  - `skill-registry/` is the discovery surface the agent reads
 *    (read-side). The two evolve independently and have different
 *    refresh triggers — keeping them split avoids a feature-folder
 *    cycle when one calls the other.
 */

import type { SkillScope } from './skill';

/**
 * One row in the rendered Markdown table. `path` is the absolute path
 * of the SKILL.md file so the agent can `Read` it directly.
 */
export interface SkillRegistryEntry {
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
  readonly path: string;
}

/**
 * Snapshot of the registry as the renderer consumes it. The Markdown
 * artifact is the source of truth on disk; the renderer reads this
 * structured snapshot via IPC to render counters and links without
 * re-parsing the file.
 */
export interface SkillRegistrySnapshot {
  /** Absolute path of the project root the registry belongs to. */
  readonly projectPath: string;
  /** Absolute path of the generated `.devia/skill-registry.md`. */
  readonly registryPath: string;
  /** Sorted by name, dedup'd (project entries win over global). */
  readonly entries: ReadonlyArray<SkillRegistryEntry>;
  /** ISO timestamp of the on-disk file (or null if not yet written). */
  readonly generatedAt: string | null;
}

/** Reasons a refresh request was a no-op. */
export type SkillRegistryRefreshReason =
  | 'ok'
  | 'no-skills'
  | 'no-project'
  | 'error';

export interface SkillRegistryRefreshResult {
  readonly reason: SkillRegistryRefreshReason;
  /** Populated when reason === 'ok'. */
  readonly snapshot?: SkillRegistrySnapshot;
  /** Populated when reason === 'error'. */
  readonly message?: string;
}

/**
 * Streamed to the renderer whenever the watcher detects a change in
 * one of the skill roots. The renderer reuses the existing toast
 * infrastructure to surface a subtle "registry actualizado" hint.
 */
export interface SkillRegistryChangedEvent {
  readonly projectPath: string;
  readonly snapshot: SkillRegistrySnapshot;
}
