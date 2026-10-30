import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizeSkillInput } from '../../../../shared/domain/ui-tools';
import type { UiToolResult } from './ui-tools-call';
import { listSubagents, loadSubagent } from './subagent-reader';

/**
 * `devia_skill` (S-25 F2.7) — every skill Devia manages, readable by ANY agent.
 *
 * S-30 T-356: Devia's harness travels with the run, so the server gets one
 * `--skills-dir` per directory Devia knows skills in (the project's agent
 * dirs and the user's global ones), not just `.claude/skills`. Earlier roots
 * win on a name clash — the core passes project roots before global ones.
 *
 * Resolved inside the MCP server process, straight off disk, rather than
 * through the rendezvous: it is a read-only file lookup that needs nothing from
 * the main process, and routing it through a round-trip would turn a cheap
 * query into a slow one.
 *
 * Every guard here exists because `name` comes from a language model.
 */

/** Anything outside this set could climb out of the skills directory. */
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;

/** A skill body far past this is a mistake, not a skill. Truncated, not refused. */
export const MAX_SKILL_BYTES = 256 * 1024;

const ENTRY_FILE = 'SKILL.md';

export interface SkillSummary {
  name: string;
  description: string;
}

/**
 * Two layouts exist on disk and both are real:
 *
 *   .claude/skills/<name>/SKILL.md            — a skill
 *   .claude/skills/<collection>/<name>/SKILL.md — a bundle installed as a set
 *
 * Found by actually running the tool: this repo's root has `angular-developer`
 * directly and 40 more inside a `skills/` collection. Scanning only the first
 * level reported ONE skill out of 41.
 *
 * One level of nesting, not arbitrary recursion: a collection of collections
 * is not a thing, and unbounded descent into a user directory is how you end
 * up walking `node_modules`.
 */
function scanSkillDirs(skillsDir: string): Array<{ name: string; dir: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  // Kept apart so top-level skills always come first: `listSkills` dedupes
  // "first one wins" and `loadSkill` takes the first match, so this ordering
  // IS the precedence rule. Directory order from `readdir` must not decide it.
  const direct: Array<{ name: string; dir: string }> = [];
  const nested: Array<{ name: string; dir: string }> = [];
  for (const entry of entries) {
    // `isDirectory()` is false for a symlink, which is what we want: a linked
    // skill folder could point anywhere on the host. This repo has one that
    // dangles at a Linux path on a macOS machine.
    if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;

    const own = path.join(skillsDir, entry.name);
    if (hasSkillFile(own)) {
      direct.push({ name: entry.name, dir: own });
      continue;
    }
    // No SKILL.md of its own → treat it as a collection and look one level in.
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(own, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || !SAFE_NAME.test(child.name)) continue;
      const childDir = path.join(own, child.name);
      if (hasSkillFile(childDir)) nested.push({ name: child.name, dir: childDir });
    }
  }
  return [...direct, ...nested];
}

export function listSkills(skillsDirs: readonly string[]): SkillSummary[] {
  const out: SkillSummary[] = [];
  const seen = new Set<string>();
  for (const root of skillsDirs) {
    for (const { name, dir } of scanSkillDirs(root)) {
      // First one wins: an earlier root, then a top-level skill over a bundled one.
      if (seen.has(name)) continue;
      const body = readSkillDir(root, dir);
      if (body === null) continue;
      seen.add(name);
      out.push({ name, description: firstDescription(body) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkill(skillsDirs: readonly string[], name: string): string | null {
  if (!SAFE_NAME.test(name)) return null;
  for (const root of skillsDirs) {
    const match = scanSkillDirs(root).find((s) => s.name === name);
    if (match) return readSkillDir(root, match.dir);
  }
  return null;
}

/**
 * Resolver for the server's `resolveLocally` hook. Returns null for every tool
 * but `skill`, so the rest fall through to the rendezvous.
 *
 * `devia_skill` serves Devia's sub-agents too (S-30 T-356): a definition is an
 * instruction set to load, exactly like a skill, and folding it in costs no new
 * tool schema in the cached prompt prefix. A skill wins a name clash.
 */
export function makeSkillResolver(
  skillsDirs: readonly string[],
  subagentsDir: string | null = null,
): (tool: string, args: unknown) => Promise<UiToolResult | null> {
  return async (tool, args) => {
    if (tool !== 'skill') return null;
    if (skillsDirs.length === 0 && !subagentsDir) {
      return { text: 'Devia manages no skills for this project.', isError: true };
    }

    const input = normalizeSkillInput(args);
    if (input === null) {
      return { text: 'Expected { op: "list" } or { op: "load", name }.', isError: true };
    }

    if (input.op === 'list') {
      const skills = listSkills(skillsDirs);
      const subagents = subagentsDir ? listSubagents(subagentsDir) : [];
      if (skills.length === 0 && subagents.length === 0) return { text: 'No skills are installed in this project.' };
      const sections = [
        ...(skills.length > 0 ? [skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')] : []),
        ...(subagents.length > 0
          ? [`Sub-agents (load one to take on its role):\n${subagents.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`]
          : []),
      ];
      return { text: sections.join('\n\n') };
    }

    const body = loadSkill(skillsDirs, input.name) ?? (subagentsDir ? loadSubagent(subagentsDir, input.name) : null);
    if (body === null) {
      return { text: `No skill named "${input.name}" in this project.`, isError: true };
    }
    return { text: body };
  };
}

/** Cheap existence probe used to tell a skill from a collection. */
function hasSkillFile(dir: string): boolean {
  try {
    const stat = fs.lstatSync(path.join(dir, ENTRY_FILE));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function readSkillDir(skillsDir: string, dir: string): string | null {
  const file = path.join(dir, ENTRY_FILE);

  // Containment: re-derive the resolved path and check it is still under the
  // root before touching it. Holds for the nested layout too, because `dir`
  // always comes from a scan rooted at `skillsDir`.
  const root = path.resolve(skillsDir);
  if (!path.resolve(file).startsWith(root + path.sep)) return null;

  try {
    // lstat, not stat: a symlink could point anywhere on the host. Same guard
    // the prompt-pack scanner uses.
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;

    const raw = fs.readFileSync(file, 'utf8');
    if (raw.length <= MAX_SKILL_BYTES) return raw;
    return `${raw.slice(0, MAX_SKILL_BYTES)}\n\n[truncated by Devia: the skill exceeds ${MAX_SKILL_BYTES} bytes]`;
  } catch {
    return null;
  }
}

/** First non-empty, non-heading, non-frontmatter line — the one-line summary. */
function firstDescription(body: string): string {
  const lines = body.split(/\r?\n/);
  let inFrontmatter = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (index === 0 && trimmed === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === '---') inFrontmatter = false;
      else if (trimmed.startsWith('description:')) {
        return trimmed.slice('description:'.length).trim().slice(0, 200);
      }
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    return trimmed.slice(0, 200);
  }
  return '(no description)';
}
