import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ConfigRepository } from '../../../shared/ports';
import { deriveCacheKey } from './source-fetcher';

/**
 * Content-addressed skill cache living under `<deviaDir>/skills/`.
 *
 *   ~/.devia-app/skills/
 *     vercel-labs-agent-skills/   ← deriveCacheKey('vercel-labs/agent-skills')
 *       frontend-design/          ← canonical skill folder
 *       skill-creator/
 *     owner-repo/
 *       my-skill/
 *
 * The cache is the single source of truth for skill content. Agent
 * directories (`<project>/.claude/skills/<name>`) hold only symlinks or
 * junctions pointing here, so installing the same skill in N projects
 * costs one copy on disk.
 *
 * The cache survives uninstall — `remove` only deletes the link from the
 * agent dir, not the cached content. That makes re-installs instant.
 * A future "Update / Limpiar caché" action can prune unreferenced
 * entries; for now the cache grows monotonically.
 */
export class SkillCache {
  constructor(private readonly config: ConfigRepository) {}

  root(): string {
    return path.join(this.config.deviaDir(), 'skills');
  }

  keyFor(source: string): string {
    return deriveCacheKey(source);
  }

  pathFor(key: string, skillName: string): string {
    return path.join(this.root(), key, skillName);
  }

  has(key: string, skillName: string): boolean {
    return fs.existsSync(this.pathFor(key, skillName));
  }

  /**
   * Copies `srcDir` into the cache slot for (key, skillName). If the slot
   * already exists we leave it alone — re-installs are cheap and the
   * upstream content rarely changes mid-session. A future Update action
   * will pass `{ force: true }` to refresh.
   */
  ensure(srcDir: string, key: string, skillName: string, force = false): string {
    const dst = this.pathFor(key, skillName);
    if (fs.existsSync(dst)) {
      if (!force) return dst;
      fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    copyDirSync(srcDir, dst);
    return dst;
  }
}

/**
 * Recursive copy tuned for skill contents — small folders, no special
 * files. We use `fs.cpSync` when available (Node ≥ 16.7) and fall back
 * to a hand-rolled walk for older runtimes.
 */
function copyDirSync(src: string, dst: string): void {
  // cpSync handles dirs + symlinks + files in one call. We dereference
  // symlinks so the cache always stores real content, even if the source
  // checkout used symlinks internally.
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dst, { recursive: true, dereference: true });
    return;
  }

  // Manual fallback for very old Node runtimes (defensive — devia targets
  // Electron 41 which bundles Node 22, so this branch shouldn't fire).
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
    else if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(s);
      const stat = fs.statSync(real);
      if (stat.isDirectory()) copyDirSync(real, d);
      else fs.copyFileSync(real, d);
    }
  }
}
