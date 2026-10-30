/**
 * Filesystem scanner for prompt packs (REV-AGENT-CORE-003).
 *
 * Walks one or more root directories looking for `<id>/PACK.md` files.
 * Returns a flat list of `PromptPack` objects. User-supplied packs are
 * preferred over built-ins when ids collide.
 *
 * Safe by construction:
 *   - skips files outside the configured roots
 *   - skips PACK.md files larger than 1 MiB
 *   - skips malformed frontmatter and logs a warning
 *   - never throws — returns an empty array on root-not-found
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PromptPack } from '../../../../shared/domain/prompt-pack';
import { parseFrontmatter } from '../domain/frontmatter';

const MAX_PACK_BYTES = 1024 * 1024; // 1 MiB

export interface ScanRoot {
  /** Absolute directory path containing `<id>/PACK.md` subfolders. */
  dir: string;
  /** Origin label stamped on every pack found under this root. */
  source: 'built-in' | 'user';
}

export function scanPromptPacks(roots: readonly ScanRoot[]): PromptPack[] {
  // Map keyed by id so collisions can resolve user-wins.
  const byId = new Map<string, PromptPack>();

  for (const root of roots) {
    if (!safeIsDir(root.dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        console.warn(`[prompt-packs] skipping symlink: ${path.join(root.dir, entry.name)}`);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const subdir = path.join(root.dir, entry.name);
      const packPath = path.join(subdir, 'PACK.md');
      if (!safeIsFile(packPath)) continue;
      const pack = readPack(packPath, entry.name, root.source);
      if (pack === null) continue;
      const existing = byId.get(pack.id);
      // User packs override built-ins; otherwise first-write wins.
      if (existing && root.source === 'built-in') continue;
      byId.set(pack.id, pack);
    }
  }

  return [...byId.values()];
}

function readPack(filePath: string, fallbackId: string, source: 'built-in' | 'user'): PromptPack | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filePath); } catch { return null; }
  if (stat.isSymbolicLink()) return null;
  if (stat.size > MAX_PACK_BYTES) {
    console.warn(`[prompt-packs] skipping ${filePath}: file exceeds ${MAX_PACK_BYTES} bytes`);
    return null;
  }
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  let parsed;
  try {
    parsed = parseFrontmatter(raw);
  } catch (err) {
    console.warn(`[prompt-packs] frontmatter parse failed for ${filePath}:`, err);
    return null;
  }
  const meta = parsed.meta;
  const id = stringValue(meta['id']) ?? fallbackId;
  const name = stringValue(meta['name']) ?? id;
  const description = stringValue(meta['description']) ?? '';
  const triggers = arrayValue(meta['triggers']);
  const body = parsed.body.trim();
  if (body.length === 0) {
    console.warn(`[prompt-packs] skipping ${filePath}: empty body`);
    return null;
  }
  const pack: PromptPack = { id, name, description, body, source };
  if (triggers.length > 0) pack.triggers = triggers;
  return pack;
}

function stringValue(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}
function arrayValue(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (typeof v === 'string' && v.length > 0) return [v.trim()];
  return [];
}
function safeIsDir(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch { return false; }
}
function safeIsFile(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return !st.isSymbolicLink() && st.isFile();
  } catch { return false; }
}
