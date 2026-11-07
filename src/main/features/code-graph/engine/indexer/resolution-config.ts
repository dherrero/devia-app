import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphQueries } from '../db/queries';
import { contentHash } from './hash';

export const CONFIG_HASHES_KEY = 'config_hashes';

// Files the resolvers read besides the sources (TS path aliases, Go modules, Dart packages).
// When one changes, every import may resolve differently, which only a full index redoes.
const CONFIG_NAMES: ReadonlySet<string> = new Set(['tsconfig.json', 'jsconfig.json', 'go.mod', 'pubspec.yaml']);

export function isResolutionConfig(rel: string): boolean {
  return CONFIG_NAMES.has(path.posix.basename(rel));
}

/** Content hash per config path, keys sorted; unreadable files are left out (as if absent). */
export function hashConfigs(files: { relPath: string; absPath: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))) {
    try {
      out[f.relPath] = contentHash(fs.readFileSync(f.absPath));
    } catch {
      // vanished between discovery and hashing
    }
  }
  return out;
}

export function storedConfigHashes(db: GraphQueries): Record<string, string> | undefined {
  const raw = db.getMeta(CONFIG_HASHES_KEY);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function sameConfigHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}
