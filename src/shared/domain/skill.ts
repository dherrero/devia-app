/**
 * Cross-process domain types for the Skills feature.
 *
 * Skills are reusable instruction sets (a `SKILL.md` file with YAML
 * frontmatter) that each CLI agent loads from a well-known directory.
 * Devia owns the install pipeline end-to-end (content-addressed cache
 * + symlinks/junctions/copies into each agent's well-known dir).
 *
 * Agent → directory mapping (verified against each vendor's docs):
 *
 *   Devia agent id   | project dir         | global dir
 *   -----------------|---------------------|---------------------------
 *   claude           | .claude/skills/     | ~/.claude/skills/
 *   codex            | .agents/skills/     | ~/.codex/skills/
 *   gemini           | .agents/skills/     | ~/.gemini/skills/
 *   opencode         | .agents/skills/     | ~/.config/opencode/skills/
 *   cursor-agent     | .agents/skills/     | ~/.cursor/skills/
 *   copilot          | .agents/skills/     | ~/.copilot/skills/
 *   qwen             | .qwen/skills/       | ~/.qwen/skills/
 *   qoder            | .qoder/skills/      | ~/.qoder/skills/
 *
 * Codex, Gemini, OpenCode, Cursor and Copilot all consume `.agents/skills/`
 * at project scope, so a skill installed there is visible to all five at
 * once. Qwen and Qoder use vendor-specific dirs only. DeepSeek is not in
 * the table because there is no canonical CLI nor a documented skills
 * directory upstream — install for DeepSeek is intentionally a no-op.
 */

export type SkillScope = 'project' | 'global';

/** Devia-internal agent identifier (must match RuntimeAgentDef.id). */
export type SkillAgent =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'cursor-agent'
  | 'copilot'
  | 'qwen'
  | 'qoder';

/**
 * One installed skill as seen by the renderer. A single directory on disk
 * can be consumed by more than one agent (the `.agents/skills/` case), so
 * we expose the set of agents that load it rather than a single agent id.
 */
export interface InstalledSkill {
  /** Slug from frontmatter (or the directory name if no frontmatter). */
  name: string;
  /** Free-form description from frontmatter; empty string when missing. */
  description: string;
  /** Absolute path of the skill directory on disk. */
  absolutePath: string;
  /** Where the skill lives — inside the project tree or in the user home. */
  scope: SkillScope;
  /** Agents that load this skill given the directory it sits in. */
  agents: SkillAgent[];
}

export interface ListSkillsResult {
  project: InstalledSkill[];
  global: InstalledSkill[];
}

export interface InstallSkillsRequest {
  /** Absolute project path; required even when scope=global (CLI cwd). */
  project: string;
  /**
   * Source accepted by the upstream CLI: `owner/repo`, full GitHub URL,
   * tree URL, GitLab URL, generic git URL, or absolute local path. Ignored
   * when `discoveryId` is set (in which case the local temp clone is used).
   */
  source: string;
  /** Agents to install the skill for. Empty array = let the CLI prompt. */
  agents: SkillAgent[];
  scope: SkillScope;
  /**
   * Specific skill names to install — each maps to a `--skill <name>` flag.
   * Empty/undefined installs every skill the source exposes.
   */
  skillNames?: string[];
  /**
   * When set, the local temp directory created by `discoverSkills` is used
   * as the source — avoids re-cloning the same repo we just scanned. The
   * runner removes the temp dir after the install finishes (ok or not).
   */
  discoveryId?: string;
}

export interface DiscoverSkillsRequest {
  source: string;
}

/**
 * One skill detected inside a freshly-cloned source. `relativePath` is
 * relative to the temp clone root and only used for debugging — the
 * upstream CLI matches by skill name, which is what we pass to install.
 */
export interface DiscoveredSkill {
  name: string;
  description: string;
  relativePath: string;
  internal: boolean;
}

export interface DiscoverSkillsResult {
  ok: boolean;
  /**
   * Server-side handle for the temp clone. Pass it back in
   * `installSkills({ discoveryId })` or call `cancelDiscovery` to free it.
   */
  discoveryId?: string;
  skills: DiscoveredSkill[];
  error?: string;
}

export interface RemoveSkillRequest {
  project: string;
  skillName: string;
  /** Agent dir to remove the skill from. */
  agent: SkillAgent;
  scope: SkillScope;
}

export interface SkillsRunResult {
  ok: boolean;
  /** Exit code from the underlying `npx skills` call, or -1 on spawn error. */
  code: number;
  /** Combined stdout + stderr, newline-separated, capped at 500 lines. */
  output: string[];
  /** Human-readable error message when ok=false. */
  error?: string;
  /**
   * Snapshot id captured BEFORE the destructive write (#270). The
   * renderer uses it to fuel the "Deshacer" toast — restoring the
   * snapshot reverts the install. Only present on a successful
   * install of new skills; remove operations don't yet support
   * undo (symlink semantics make it tricky for v1).
   */
  snapshotId?: string;
}
