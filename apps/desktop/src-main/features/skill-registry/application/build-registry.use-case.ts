import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  SkillRegistryEntry,
  SkillRegistryRefreshResult,
  SkillRegistrySnapshot,
} from '../../../../shared/domain/skill-registry';
import type { InstalledSkill, ListSkillsResult } from '../../../../shared/domain/skill';
import type { SkillListReader } from '../../../shared/ports';
import { renderSkillRegistry } from '../infrastructure/skill-registry-writer';
import { ensureGitignoreEntry } from '../infrastructure/gitignore';

const REGISTRY_DIR = '.devia';
const REGISTRY_FILE = 'skill-registry.md';

/**
 * Generates / refreshes the per-project Skill Registry index (#269).
 *
 * The use case is a thin orchestrator on top of the existing
 * SkillReader port (write-side feature, read-side feature share data
 * via the same domain types). It deduplicates so project-scope skills
 * always win against global-scope skills with the same name, renders
 * the markdown table, writes it idempotently, and adds the registry
 * dir to the project's `.gitignore` on first generation.
 *
 * Why no automatic generation for empty projects: an empty
 * `.devia/skill-registry.md` would clutter the project tree without
 * communicating anything to the agent. We delete a stale file when
 * the skill count drops to zero.
 */
export class BuildSkillRegistryUseCase {
  constructor(private readonly reader: SkillListReader) {}

  async refresh(projectPath: string): Promise<SkillRegistryRefreshResult> {
    if (!projectPath || !this.isDirSafe(projectPath)) {
      return { reason: 'no-project' };
    }
    let result: ListSkillsResult;
    try {
      result = this.reader.list(projectPath);
    } catch (err) {
      return {
        reason: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const entries = mergeAndSort(result);
    const registryPath = path.join(projectPath, REGISTRY_DIR, REGISTRY_FILE);

    if (entries.length === 0) {
      // Drop any stale file so the project tree stays clean.
      try { fs.rmSync(registryPath, { force: true }); } catch { /* noop */ }
      return { reason: 'no-skills' };
    }

    try {
      const md = renderSkillRegistry(entries, projectPath);
      writeIfChanged(registryPath, md);
      ensureGitignoreEntry(projectPath, `${REGISTRY_DIR}/`);
    } catch (err) {
      return {
        reason: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const snapshot: SkillRegistrySnapshot = {
      projectPath,
      registryPath,
      entries,
      generatedAt: this.statIso(registryPath),
    };
    return { reason: 'ok', snapshot };
  }

  /**
   * Read-only snapshot without forcing a regeneration. Used by the
   * `status` IPC channel so the sidebar counter can render without
   * paying the watcher's debounce cost on every render.
   */
  status(projectPath: string): SkillRegistrySnapshot | null {
    if (!projectPath || !this.isDirSafe(projectPath)) return null;
    let result: ListSkillsResult;
    try {
      result = this.reader.list(projectPath);
    } catch {
      return null;
    }
    const entries = mergeAndSort(result);
    const registryPath = path.join(projectPath, REGISTRY_DIR, REGISTRY_FILE);
    return {
      projectPath,
      registryPath,
      entries,
      generatedAt: this.statIso(registryPath),
    };
  }

  private isDirSafe(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  }

  private statIso(p: string): string | null {
    try { return fs.statSync(p).mtime.toISOString(); } catch { return null; }
  }
}

/**
 * Merge project + global entries with project-wins dedup. Skills are
 * already attributed to one or more agents by the reader; here we
 * collapse a single skill (by name) to one row so the agent doesn't
 * see the same SKILL.md listed twice.
 */
function mergeAndSort(result: ListSkillsResult): SkillRegistryEntry[] {
  const seen = new Map<string, SkillRegistryEntry>();

  const consume = (list: ReadonlyArray<InstalledSkill>) => {
    for (const skill of list) {
      // Project-scope already wins because we consume `project` first;
      // a second hit with the same name from the global list is dropped.
      if (seen.has(skill.name)) continue;
      seen.set(skill.name, {
        name: skill.name,
        description: skill.description,
        scope: skill.scope,
        path: skill.absolutePath,
      });
    }
  };

  consume(result.project);
  consume(result.global);

  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function writeIfChanged(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Read-modify-compare-write: skipping when the body matches keeps the
  // file's mtime stable, which prevents the watcher from echoing back
  // into a refresh loop after we regenerated it ourselves.
  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch { /* not present */ }
  if (existing === content) return;
  fs.writeFileSync(filePath, content, 'utf8');
}
