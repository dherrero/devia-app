import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  DiscoveredSkill,
  DiscoverSkillsRequest,
  DiscoverSkillsResult,
} from '../../../../shared/domain/skill';
import { parseFrontmatter } from './frontmatter';
import {
  cleanup as cleanupSource,
  materialiseSource,
  type MaterialisedSource,
} from './source-fetcher';

/** Bounds the recursive scan so we don't walk node_modules / .git. */
const SCAN_MAX_DEPTH = 5;
const SCAN_IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'out', 'coverage',
  '.cache', 'target', '.venv', 'venv', '__pycache__',
]);

interface DiscoveryEntry {
  tempDir: string;
  /** Where the scanner / installer should read from (may differ from
   *  tempDir when the source URL pointed at a subtree). */
  scanRoot: string;
  isLocal: boolean;
  createdAt: number;
}

/**
 * Two-step install helper: clones a skill source into an OS temp dir, then
 * scans every directory containing a `SKILL.md` so the renderer can show
 * the user a multi-select picker. The temp dir is registered under a
 * `discoveryId` and either consumed by a follow-up install (which uses
 * the local path as source — no second clone) or freed by `release`.
 *
 * `dispose()` is called at app shutdown to wipe any leftover temp dirs
 * if the user closes Devia mid-flow.
 */
export class SkillDiscoverer {
  private readonly entries = new Map<string, DiscoveryEntry>();

  async discover(req: DiscoverSkillsRequest): Promise<DiscoverSkillsResult> {
    let materialised: MaterialisedSource;
    try {
      materialised = await materialiseSource(req.source ?? '');
    } catch (err) {
      return {
        ok: false,
        skills: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const skills = this.scan(materialised.scanRoot);
    if (skills.length === 0) {
      cleanupSource(materialised.tempDir);
      return {
        ok: false,
        skills: [],
        error: 'No se encontraron SKILL.md en la fuente indicada',
      };
    }

    const discoveryId = randomUUID();
    this.entries.set(discoveryId, {
      tempDir: materialised.tempDir,
      scanRoot: materialised.scanRoot,
      isLocal: materialised.isLocal,
      createdAt: Date.now(),
    });
    return { ok: true, discoveryId, skills };
  }

  /**
   * Path the install pipeline should scan/copy from when reusing a
   * previously-discovered source. Returns `null` if the id is unknown,
   * so callers can fall back to re-cloning the original URL.
   */
  pathFor(discoveryId: string): string | null {
    const entry = this.entries.get(discoveryId);
    return entry ? entry.scanRoot : null;
  }

  /** Frees the temp dir associated with the id (no-op if unknown). */
  release(discoveryId: string): boolean {
    const entry = this.entries.get(discoveryId);
    if (!entry) return false;
    this.entries.delete(discoveryId);
    cleanupSource(entry.tempDir);
    return true;
  }

  dispose(): void {
    for (const entry of this.entries.values()) cleanupSource(entry.tempDir);
    this.entries.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────
  private scan(root: string): DiscoveredSkill[] {
    const showInternal = isInternalAllowed();
    const out: DiscoveredSkill[] = [];
    const seen = new Set<string>();

    const visit = (dir: string, depth: number) => {
      if (depth > SCAN_MAX_DEPTH) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      // If this dir contains a SKILL.md, treat it as a skill and stop
      // recursing into it. We don't expect nested SKILL.md files; the
      // upstream spec keeps each skill in its own folder.
      const hasSkill = entries.some(
        (e) => e.isFile() && e.name === 'SKILL.md',
      );
      if (hasSkill) {
        const skill = this.buildSkill(root, dir);
        if (skill && (showInternal || !skill.internal) && !seen.has(skill.relativePath)) {
          seen.add(skill.relativePath);
          out.push(skill);
        }
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SCAN_IGNORE_DIRS.has(entry.name)) continue;
        // .curated / .experimental / .system are valid upstream skill
        // buckets, so we don't blanket-skip hidden dirs — only the
        // obviously non-skill ones above and dot-dirs that aren't likely
        // to host content.
        if (entry.name === '.git' || entry.name === '.github') continue;
        visit(path.join(dir, entry.name), depth + 1);
      }
    };

    visit(root, 0);
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private buildSkill(root: string, dir: string): DiscoveredSkill | null {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    } catch {
      return null;
    }
    const fm = parseFrontmatter(raw);
    const relativePath = path.relative(root, dir) || '.';
    return {
      name: fm.name ?? path.basename(dir),
      description: fm.description ?? '',
      relativePath,
      internal: fm.internal === true,
    };
  }
}

function isInternalAllowed(): boolean {
  const flag = process.env['INSTALL_INTERNAL_SKILLS'];
  return flag === '1' || flag === 'true';
}

// Re-export tmpdir for legacy callers that wanted to know our temp prefix.
// Kept so the existing safe-rm guard in tests stays valid.
export const TEMP_PREFIX = os.tmpdir();
