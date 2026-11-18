import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphQueries } from '../db/queries';
import { languageForPath } from '../extraction/grammars';
import { pathConfigFiles } from '../resolution/path-aliases';
import { contentHash } from './hash';

// Renamed when the tracked set grew to the tsconfig extends/references closure: graphs stored
// under an older key ask for one full index.
export const CONFIG_HASHES_KEY = 'resolution_config_hashes';

const MISSING = 'missing';

// Go modules and Dart packages, found by discovery; tsconfig/jsconfig files are instead
// derived from the TS path-alias loader so that its `extends`/`references` are covered.
const MODULE_CONFIG_NAMES: ReadonlySet<string> = new Set(['go.mod', 'pubspec.yaml']);

export function isResolutionConfig(rel: string): boolean {
  return MODULE_CONFIG_NAMES.has(path.posix.basename(rel));
}

function hashFile(abs: string): string {
  try {
    return contentHash(fs.readFileSync(abs));
  } catch {
    return MISSING;
  }
}

/**
 * Hashes of every non-source file the resolvers read: the given Go/Dart manifests plus every
 * tsconfig/jsconfig the path-alias loader may read for the TS/JS files among `sourceFiles`.
 * When any of them changes, imports may resolve differently and only a full index redoes it.
 */
export function resolutionConfigHashes(
  root: string,
  sourceFiles: string[],
  moduleConfigs: string[],
): Record<string, string> {
  const tsFiles = sourceFiles.filter((f) => {
    const lang = languageForPath(f);
    return lang === 'typescript' || lang === 'javascript';
  });
  const rels = new Set([...moduleConfigs, ...pathConfigFiles(root, tsFiles)]);
  const out: Record<string, string> = {};
  for (const rel of [...rels].sort()) out[rel] = hashFile(path.join(root, ...rel.split('/')));
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
