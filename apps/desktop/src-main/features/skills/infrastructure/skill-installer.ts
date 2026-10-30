import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  InstallSkillsRequest,
  RemoveSkillRequest,
  SkillsRunResult,
  SkillAgent,
} from '../../../../shared/domain/skill';
import { agentById } from '../domain/agent-map';
import {
  cleanup as cleanupSource,
  materialiseSource,
  type MaterialisedSource,
} from './source-fetcher';
import type { SkillDiscoverer } from './skill-discoverer';
import type { SkillCache } from './skill-cache';
import type { SnapshotCapturer } from '../../../shared/ports';

const OUTPUT_LINE_CAP = 500;

/**
 * Skill install / remove engine. Replaces the previous `npx skills`
 * wrapper — devia now owns the install pipeline end-to-end:
 *
 *   discover (clone temp) ──┐
 *                            ├─→ copy each picked skill into ~/.devia-app/skills/<key>/<name>/
 *   install ─────────────────┘     (skipped if already cached)
 *                                  ↓
 *                          symlink (or junction on Windows, copy on
 *                          fallback) into <project>/.<agent>/skills/<name>
 *                          for every selected agent.
 *
 * Why our own pipeline instead of the upstream `skills` CLI:
 *  - One copy per (owner, repo, skill) shared by every project that
 *    installs it, instead of one per agent dir.
 *  - No dependency on `npx` / network availability after the first clone.
 *  - The install/remove operations are pure FS calls — fast and easy
 *    to reason about, with no opaque stdout to parse.
 */
export class SkillInstaller {
  constructor(
    private readonly discoverer: SkillDiscoverer,
    private readonly cache: SkillCache,
    /** Optional — when wired, every install captures a snapshot of
     *  the to-be-created link paths BEFORE the linkOrCopy so the
     *  renderer can offer a "Deshacer" toast. Pre-creation paths are
     *  recorded with `existed: false`; restore = delete them. */
    private readonly snapshot?: SnapshotCapturer,
  ) {}

  async install(req: InstallSkillsRequest): Promise<SkillsRunResult> {
    if (!req.project || !fs.existsSync(req.project)) {
      return failed(`Project path no existe: ${req.project}`);
    }

    // ── Resolve source. Prefer the temp clone the discoverer kept from
    //    the picker step — saves a redundant network fetch.
    let scanRoot: string;
    let tempToCleanup = '';
    const discoveryPath = req.discoveryId
      ? this.discoverer.pathFor(req.discoveryId)
      : null;

    if (discoveryPath) {
      scanRoot = discoveryPath;
    } else {
      let materialised: MaterialisedSource;
      try {
        materialised = await materialiseSource(req.source ?? '');
      } catch (err) {
        return failed(err instanceof Error ? err.message : String(err));
      }
      scanRoot = materialised.scanRoot;
      tempToCleanup = materialised.tempDir;
    }

    const log: string[] = [];
    const pushLine = (line: string) => {
      if (log.length >= OUTPUT_LINE_CAP) log.shift();
      log.push(line);
    };

    try {
      const names = (req.skillNames ?? []).map((n) => n.trim()).filter(Boolean);
      if (names.length === 0) {
        return failed('No se indicó ninguna skill a instalar');
      }
      // We enforce an explicit agent selection — silently installing to
      // every agent would be a surprise. The renderer already disables
      // the install button until at least one agent is checked, but we
      // double-check here for defence in depth.
      const agents = req.agents;
      if (agents.length === 0) {
        return failed('Selecciona al menos un agente destino');
      }

      const cacheKey = this.cache.keyFor(req.source ?? '');
      pushLine(`Caché: ${this.cache.root()}/${cacheKey}`);

      // #270: collect every link path we're about to touch and
      // snapshot them BEFORE any write. Pre-existing entries (e.g.
      // re-install of the same skill) get captured with their
      // current content; new paths are recorded with existed:false
      // so restore = delete.
      const linkTargets: string[] = [];
      for (const name of names) {
        for (const agent of agents) {
          const dest = destinationFor(agent, req.scope, req.project);
          if (!dest) continue;
          linkTargets.push(path.join(dest, name));
        }
      }
      let snapshotId: string | undefined;
      if (this.snapshot && linkTargets.length > 0) {
        try {
          const snap = this.snapshot.execute({
            feature: 'skills',
            reason: `skills:install "${names.join(', ')}" for ${agents.join('+')}`,
            paths: linkTargets,
            projectPath: req.project,
          });
          snapshotId = snap.id;
        } catch (err) {
          // Snapshot is a safety net; never block the install when it
          // fails. We log it and move on without an undo token.
          pushLine(`(snapshot skipped: ${err instanceof Error ? err.message : String(err)})`);
        }
      }

      // ── 1. Make sure every picked skill lives in the cache. We scan
      //    the materialised source for SKILL.md files and match by skill
      //    name (frontmatter or directory name).
      const found = findSkillsByName(scanRoot, names);
      for (const name of names) {
        const srcSkillDir = found.get(name);
        if (!srcSkillDir) {
          pushLine(`! Skill "${name}" no encontrada en la fuente`);
          continue;
        }
        const cachedPath = this.cache.ensure(srcSkillDir, cacheKey, name);
        pushLine(`✓ Cacheado: ${cacheKey}/${name}`);
        // 2. Link the cached folder into every selected agent dir.
        for (const agent of agents) {
          const dest = destinationFor(agent, req.scope, req.project);
          if (!dest) continue;
          ensureDir(dest);
          const linkPath = path.join(dest, name);
          const mode = linkOrCopy(cachedPath, linkPath);
          pushLine(`  → ${agentLabel(agent)} (${mode}): ${linkPath}`);
        }
      }

      return {
        ok: true,
        code: 0,
        output: log,
        ...(snapshotId !== undefined && { snapshotId }),
      };
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err), log);
    } finally {
      if (req.discoveryId) this.discoverer.release(req.discoveryId);
      if (tempToCleanup) cleanupSource(tempToCleanup);
    }
  }

  async remove(req: RemoveSkillRequest): Promise<SkillsRunResult> {
    if (!req.project || !fs.existsSync(req.project)) {
      return failed(`Project path no existe: ${req.project}`);
    }
    const name = (req.skillName ?? '').trim();
    if (!name) return failed('Falta el nombre del skill');
    const mapping = agentById(req.agent);
    if (!mapping) return failed(`Agente desconocido: ${req.agent}`);

    const dest = destinationFor(req.agent, req.scope, req.project);
    if (!dest) return failed(`Sin directorio para el agente ${req.agent}`);
    const target = path.join(dest, name);

    if (!fs.existsSync(target) && !isBrokenSymlink(target)) {
      return failed(`No existe ${target}`);
    }

    try {
      // lstat (not stat) so we hit the symlink itself, not its target.
      // Symlinks/junctions → unlink. Real directories (copy fallback)
      // → recursive rm. Files (shouldn't happen) → unlink.
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
      }
      return { ok: true, code: 0, output: [`Eliminado ${target}`] };
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

function failed(error: string, output: string[] = []): SkillsRunResult {
  return { ok: false, code: -1, output, error };
}

function destinationFor(agent: SkillAgent, scope: 'project' | 'global', projectAbs: string): string | null {
  const mapping = agentById(agent);
  if (!mapping) return null;
  if (scope === 'project') return path.join(projectAbs, mapping.projectDir);
  return mapping.globalDir(os.homedir());
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function agentLabel(agent: SkillAgent): string {
  switch (agent) {
    case 'claude':       return 'Claude Code';
    case 'codex':        return 'Codex';
    case 'gemini':       return 'Gemini CLI';
    case 'opencode':     return 'OpenCode';
    case 'cursor-agent': return 'Cursor Agent';
    case 'copilot':      return 'GitHub Copilot CLI';
    case 'qwen':         return 'Qwen Code';
    case 'qoder':        return 'Qoder CLI';
  }
}

function isBrokenSymlink(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/**
 * Replace `dst` with a link/junction/copy pointing at `src`. Returns the
 * mode that worked so the caller can surface it in the log.
 *
 * Strategy:
 *   - posix      → `fs.symlinkSync(src, dst, 'dir')`.
 *   - Windows    → try `fs.symlinkSync(src, dst, 'junction')` first; if
 *                  it throws (e.g. cross-volume — junctions can't span
 *                  drives), fall back to a recursive copy.
 *
 * Any pre-existing entry at `dst` is removed first so re-installs are
 * idempotent. We use `lstat` to avoid following a stale symlink.
 */
function linkOrCopy(src: string, dst: string): 'symlink' | 'junction' | 'copy' {
  if (fs.existsSync(dst) || isBrokenSymlink(dst)) {
    const stat = fs.lstatSync(dst);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.rmSync(dst, { recursive: true, force: true });
    } else {
      fs.unlinkSync(dst);
    }
  }

  if (process.platform === 'win32') {
    try {
      fs.symlinkSync(src, dst, 'junction');
      return 'junction';
    } catch {
      copyDirRecursive(src, dst);
      return 'copy';
    }
  }

  fs.symlinkSync(src, dst, 'dir');
  return 'symlink';
}

function copyDirRecursive(src: string, dst: string): void {
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dst, { recursive: true, dereference: true });
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Walks `root` looking for directories whose `SKILL.md` frontmatter
 * `name` (or directory basename, as fallback) matches one of `wanted`.
 * Stops descending once a `SKILL.md` is found — skills are flat trees.
 */
function findSkillsByName(root: string, wanted: string[]): Map<string, string> {
  const want = new Set(wanted);
  const out = new Map<string, string>();
  const MAX_DEPTH = 6;

  const visit = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || out.size === want.size) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const name = readSkillName(dir);
      if (name && want.has(name) && !out.has(name)) out.set(name, dir);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };

  visit(root, 0);
  return out;
}

function readSkillName(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (m && m[1]) {
      const nameLine = /^name\s*:\s*(.+?)\s*$/m.exec(m[1]);
      if (nameLine && nameLine[1]) {
        return nameLine[1].replace(/^["']|["']$/g, '').trim();
      }
    }
  } catch { /* fall through */ }
  return path.basename(dir);
}
