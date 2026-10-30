import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEVIA_MANAGED_KEY } from './marker-merge';

/**
 * One-shot migration of MCP entries Devia wrote to the wrong path in
 * earlier versions (#272 era — fixed in T-50 of S-3).
 *
 * Three legacy paths were corrected:
 *
 *   1. Claude global → `~/.claude/mcp.json` (never read by Claude Code)
 *      → `~/.claude.json` `mcpServers` top-level.
 *   2. OpenCode project → `<project>/.opencode/opencode.json`
 *      → `<project>/opencode.json`.
 *   3. Copilot global → `~/.copilot/mcp.json`
 *      → `~/.copilot/mcp-config.json`.
 *
 * For each path we look for entries carrying the `__devia_managed`
 * marker, move them to the correct file (preserving everything else
 * in the destination), and either delete the source file (when it's
 * empty or only had Devia entries) or rewrite it without the moved
 * entries. Hand-edited entries the user added without the marker are
 * left in place — we never destroy unmanaged data.
 *
 * Idempotent: running again is a no-op once the source file is gone
 * or stripped of Devia entries.
 *
 * The runtime path migration for the project-scope OpenCode file is
 * opportunistic — we don't walk the workspace looking for legacy
 * configs. We only migrate the project Devia is opening at startup
 * (passed in via `lastProjectPath`); other projects migrate when the
 * user opens them next.
 */

export interface LegacyMigrationContext {
  home: string;
  lastProjectPath?: string;
  /** Injectable logger (defaults to console.log via the optional log fn). */
  log?: (msg: string) => void;
}

export interface LegacyMigrationResult {
  /** Absolute paths whose contents we touched (moved-from + moved-to). */
  movedFiles: string[];
  /** Server ids relocated, per source path. Empty when nothing changed. */
  movedEntries: Array<{ from: string; to: string; ids: string[] }>;
}

export function migrateLegacyMcpPaths(
  ctx: LegacyMigrationContext,
): LegacyMigrationResult {
  const result: LegacyMigrationResult = { movedFiles: [], movedEntries: [] };
  const log = ctx.log ?? ((m) => console.log(`[mcp:migration] ${m}`));

  // 1. Claude global: ~/.claude/mcp.json → ~/.claude.json (top-level
  //    `mcpServers`).
  migrateJsonMerge({
    from: path.join(ctx.home, '.claude', 'mcp.json'),
    fromParentKey: 'mcpServers',
    to: path.join(ctx.home, '.claude.json'),
    toParentKey: 'mcpServers',
    deleteFromWhenEmpty: true,
    label: 'claude global',
    result,
    log,
  });

  // 2. Copilot global: ~/.copilot/mcp.json → ~/.copilot/mcp-config.json.
  migrateJsonMerge({
    from: path.join(ctx.home, '.copilot', 'mcp.json'),
    fromParentKey: 'mcpServers',
    to: path.join(ctx.home, '.copilot', 'mcp-config.json'),
    toParentKey: 'mcpServers',
    deleteFromWhenEmpty: true,
    label: 'copilot global',
    result,
    log,
  });

  // 3. OpenCode project: <project>/.opencode/opencode.json
  //    → <project>/opencode.json. Only attempted for the project Devia
  //    opens at startup; others migrate the next time they're opened.
  if (ctx.lastProjectPath) {
    migrateJsonMerge({
      from: path.join(ctx.lastProjectPath, '.opencode', 'opencode.json'),
      fromParentKey: 'mcp',
      to: path.join(ctx.lastProjectPath, 'opencode.json'),
      toParentKey: 'mcp',
      deleteFromWhenEmpty: true,
      label: `opencode project (${ctx.lastProjectPath})`,
      result,
      log,
    });
  }

  return result;
}

interface JsonMergeMigration {
  from: string;
  fromParentKey: string;
  to: string;
  toParentKey: string;
  /** When the source has no entries left after migration, delete it. */
  deleteFromWhenEmpty: boolean;
  label: string;
  result: LegacyMigrationResult;
  log: (msg: string) => void;
}

function migrateJsonMerge(input: JsonMergeMigration): void {
  if (!fs.existsSync(input.from)) return;

  const fromRoot = readJsonSafe(input.from);
  if (!fromRoot) return;

  const fromMap = (fromRoot[input.fromParentKey] && typeof fromRoot[input.fromParentKey] === 'object')
    ? { ...(fromRoot[input.fromParentKey] as Record<string, unknown>) }
    : null;
  if (!fromMap) return;

  const movedIds: string[] = [];
  const keptInSource: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(fromMap)) {
    if (isDeviaManaged(entry, id)) {
      movedIds.push(id);
    } else {
      keptInSource[id] = entry;
    }
  }
  if (movedIds.length === 0) return;

  // ── Merge into the destination ─────────────────────────────────
  const toRoot = readJsonSafe(input.to) ?? {};
  const toMap = (toRoot[input.toParentKey] && typeof toRoot[input.toParentKey] === 'object')
    ? { ...(toRoot[input.toParentKey] as Record<string, unknown>) }
    : {};
  for (const id of movedIds) {
    toMap[id] = fromMap[id];
  }
  toRoot[input.toParentKey] = toMap;
  writeAtomically(input.to, JSON.stringify(toRoot, null, 2) + '\n');
  input.result.movedFiles.push(input.to);

  // ── Rewrite or delete the source ───────────────────────────────
  const remaining = Object.keys(keptInSource).length;
  const otherTopLevelKeys = Object.keys(fromRoot).filter((k) => k !== input.fromParentKey);
  if (remaining === 0 && otherTopLevelKeys.length === 0 && input.deleteFromWhenEmpty) {
    try { fs.rmSync(input.from, { force: true }); } catch { /* swallow */ }
  } else {
    const nextSource: Record<string, unknown> = { ...fromRoot };
    if (remaining === 0) {
      delete nextSource[input.fromParentKey];
    } else {
      nextSource[input.fromParentKey] = keptInSource;
    }
    writeAtomically(input.from, JSON.stringify(nextSource, null, 2) + '\n');
  }
  input.result.movedFiles.push(input.from);

  input.result.movedEntries.push({ from: input.from, to: input.to, ids: movedIds });
  input.log(`Moved ${movedIds.length} ${input.label} entr${movedIds.length === 1 ? 'y' : 'ies'} (${movedIds.join(', ')}) → ${input.to}`);
}

function isDeviaManaged(entry: unknown, id: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const marker = (entry as Record<string, unknown>)[DEVIA_MANAGED_KEY];
  return marker === id || marker === 'devia';
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeAtomically(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}
