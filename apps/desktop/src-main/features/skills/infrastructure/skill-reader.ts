import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  InstalledSkill,
  ListSkillsResult,
  SkillAgent,
  SkillScope,
} from '../../../../shared/domain/skill';
import { SKILL_AGENT_MAP } from '../domain/agent-map';
import { parseFrontmatter } from './frontmatter';

/**
 * Scans the filesystem for installed skills.
 *
 * Project scope looks under each agent's project dir (e.g.
 * `<project>/.claude/skills`, `<project>/.agents/skills`). Global scope
 * scans each agent's home directory. Because Codex/Gemini/OpenCode all
 * share `.agents/skills/`, the same physical folder is attributed to all
 * three agents in the response.
 *
 * Skills marked `metadata.internal: true` are returned only when the
 * `INSTALL_INTERNAL_SKILLS` env var is set, mirroring the upstream CLI
 * behaviour so the renderer matches what `npx skills add --list` would
 * surface.
 */
export class SkillReader {
  private readonly showInternal: boolean;

  constructor(private readonly homeDir: string = os.homedir()) {
    const flag = process.env['INSTALL_INTERNAL_SKILLS'];
    this.showInternal = flag === '1' || flag === 'true';
  }

  list(projectRoot: string): ListSkillsResult {
    return {
      project: this.scanProject(projectRoot),
      global: this.scanGlobal(),
    };
  }

  private scanProject(projectRoot: string): InstalledSkill[] {
    if (!projectRoot || !this.isDir(projectRoot)) return [];

    const byPath = new Map<string, InstalledSkill>();
    for (const mapping of SKILL_AGENT_MAP) {
      const dir = path.join(projectRoot, mapping.projectDir);
      for (const skill of this.scanDir(dir, 'project')) {
        const existing = byPath.get(skill.absolutePath);
        if (existing) {
          if (!existing.agents.includes(mapping.agent)) {
            existing.agents.push(mapping.agent);
          }
        } else {
          byPath.set(skill.absolutePath, { ...skill, agents: [mapping.agent] });
        }
      }
    }
    return Array.from(byPath.values()).sort(byName);
  }

  private scanGlobal(): InstalledSkill[] {
    const byPathPerAgent = new Map<string, InstalledSkill>();
    for (const mapping of SKILL_AGENT_MAP) {
      const dir = mapping.globalDir(this.homeDir);
      for (const skill of this.scanDir(dir, 'global')) {
        // Global dirs are agent-specific (no sharing like `.agents/skills/`),
        // so a unique key per (path, agent) keeps separate entries when two
        // agents happen to symlink to the same physical canonical skill.
        const key = `${mapping.agent}::${skill.absolutePath}`;
        byPathPerAgent.set(key, { ...skill, agents: [mapping.agent] });
      }
    }
    return Array.from(byPathPerAgent.values()).sort(byName);
  }

  private scanDir(
    dir: string,
    scope: SkillScope,
  ): Array<Omit<InstalledSkill, 'agents'> & { agents: SkillAgent[] }> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: Array<Omit<InstalledSkill, 'agents'> & { agents: SkillAgent[] }> = [];
    for (const entry of entries) {
      // Hidden curated/experimental/system buckets ship in some skill repos
      // (e.g. .curated/, .experimental/) — keep them out of the user's view
      // since they're not directly addressable installs.
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

      const skillPath = path.join(dir, entry.name);
      // Either a real directory or a symlink to one (the CLI's default
      // install mode is symlinking).
      if (!this.isDirOrLinkToDir(skillPath, entry)) continue;

      const skillMd = path.join(skillPath, 'SKILL.md');
      let frontmatter = parseFrontmatter(this.readTextSafe(skillMd));
      if (!frontmatter.name && !frontmatter.description) {
        // Fall back to the directory name so corrupted/legacy skills still
        // appear in the list and are removable from the UI.
        frontmatter = { name: entry.name };
      }
      if (frontmatter.internal && !this.showInternal) continue;

      out.push({
        name: frontmatter.name ?? entry.name,
        description: frontmatter.description ?? '',
        absolutePath: skillPath,
        scope,
        agents: [],
      });
    }
    return out;
  }

  private isDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  }

  private isDirOrLinkToDir(p: string, entry: fs.Dirent): boolean {
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  }

  private readTextSafe(p: string): string {
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
  }
}

function byName(a: InstalledSkill, b: InstalledSkill): number {
  return a.name.localeCompare(b.name);
}
