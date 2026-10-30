import * as fs from 'node:fs';
import * as path from 'node:path';

import type { McpAgentId, McpServerConfig } from '../../../../shared/domain/mcp';
import type { McpAgentTarget } from '../domain/agent-targets';
import { mergeJson, mergeToml } from './marker-merge';
import { composeServerEnv } from './temp-config-writer';

/**
 * Per-agent writer that materialises Devia-managed servers into the
 * agent's native config file (#272).
 *
 * Three strategies:
 *   - json-merge      → load, apply marker-merge, write atomically.
 *   - toml-merge      → load text, apply TOML marker-merge, write
 *                       atomically.
 *   - separate-file   → write one `<dir>/<serverId>.json` per server,
 *                       remove files for ids that aren't in the
 *                       managed list (used by Claude global scope).
 *
 * Atomicity: every write goes through temp-file + rename so a
 * mid-write crash never leaves a corrupt file.
 */

export interface SyncTargetInput {
  agent: McpAgentId;
  target: McpAgentTarget;
  /** Servers this agent should expose, in the order they should
   *  appear in the output. */
  managed: ReadonlyArray<McpServerConfig>;
  /** Server ids to explicitly remove (Devia-managed only). */
  removedIds?: ReadonlyArray<string>;
  /** Parent env passed through to composeServerEnv for filtering. */
  parentEnv: NodeJS.ProcessEnv;
  /**
   * json-merge only: drop Devia-managed entries missing from `managed`.
   * Defaults to true (catalog sync). Single-server injectors pass false.
   */
  prune?: boolean;
}

export class McpSyncWriter {
  /**
   * Write the target file according to its strategy. Idempotent —
   * when the resulting content matches what's on disk we skip the
   * write so external watchers don't echo back into a refresh loop.
   *
   * Returns the absolute path of the file that was touched (or
   * would have been touched) so the caller can include it in the
   * snapshot pre-image.
   */
  write(input: SyncTargetInput): string {
    const { target } = input;
    if (target.strategy === 'separate-file') {
      this.writeSeparateFile(input);
      return target.perServerDir ?? target.file;
    }
    if (target.strategy === 'toml-merge') {
      this.writeTomlMerge(input);
      return target.file;
    }
    if (target.strategy === 'grok-array') {
      this.writeGrokArray(input);
      return target.file;
    }
    this.writeJsonMerge(input);
    return target.file;
  }

  /** Pre-flight: list every file the writer WOULD touch so the
   *  snapshot use case can capture them BEFORE the write. */
  pathsToTouch(input: SyncTargetInput): string[] {
    const { target } = input;
    if (target.strategy === 'separate-file' && target.perServerDir) {
      return [
        ...input.managed.map((s) => path.join(target.perServerDir as string, `${s.id}.json`)),
        ...(input.removedIds ?? []).map((id) => path.join(target.perServerDir as string, `${id}.json`)),
      ];
    }
    return [target.file];
  }

  // ── strategies ──────────────────────────────────────────────────

  private writeJsonMerge(input: SyncTargetInput): void {
    const root = readJsonSafe(input.target.file);
    const parentKey = input.target.jsonParentKey ?? 'mcpServers';
    const next = mergeJson(root, {
      parentKey,
      managed: input.managed,
      ...(input.removedIds !== undefined && { removedIds: input.removedIds }),
      ...(input.target.jsonEntryShape !== undefined && { entryShape: input.target.jsonEntryShape }),
      ...(input.prune !== undefined && { prune: input.prune }),
      emitExposure: input.agent === 'pi',
      composeEnv: (s) => composeServerEnv(s, input.parentEnv),
    });
    writeAtomically(input.target.file, JSON.stringify(next, null, 2) + '\n');
  }

  /**
   * grok-dev stores MCP servers as a NESTED ARRAY under `mcp.servers` in
   * `~/.grok/user-settings.json`, each entry `{ id, label, enabled, transport,
   * command, args, env }` (grok-cli src/utils/settings.ts). Devia-managed
   * entries are identified by their reserved ids (`devia-memory`/`devia-kanban`)
   * rather than a marker key, because grok validates the server schema and may
   * reject unknown fields. We drop any prior entry with a managed/removed id,
   * then append the fresh ones — every other server (and unrelated top-level
   * settings) is preserved.
   *
   * NOTE: this file is GLOBAL (grok has no project-scope MCP config), so two
   * Devia projects running grok concurrently race on the `--project` identity.
   * Acceptable for the common single-active-project desktop case; the write
   * happens immediately before spawn so a sequential run is always correct.
   */
  private writeGrokArray(input: SyncTargetInput): void {
    const root = readJsonSafe(input.target.file) ?? {};
    const mcp = isObject(root['mcp']) ? { ...(root['mcp'] as Record<string, unknown>) } : {};
    const existing = Array.isArray(mcp['servers']) ? (mcp['servers'] as unknown[]) : [];

    const drop = new Set<string>([
      ...input.managed.map((s) => s.id),
      ...(input.removedIds ?? []),
    ]);
    const kept = existing.filter(
      (e) => !(isObject(e) && typeof e['id'] === 'string' && drop.has(e['id'])),
    );

    const added = input.managed.map((s) => {
      const env = composeServerEnv(s, input.parentEnv);
      const entry: Record<string, unknown> = {
        id: s.id,
        label: s.name ?? s.id,
        enabled: true,
        transport: 'stdio',
        command: s.command,
        args: s.args ?? [],
      };
      if (Object.keys(env).length > 0) entry['env'] = env;
      return entry;
    });

    mcp['servers'] = [...kept, ...added];
    const next = { ...root, mcp };
    writeAtomically(input.target.file, JSON.stringify(next, null, 2) + '\n');
  }

  private writeTomlMerge(input: SyncTargetInput): void {
    const current = readTextSafe(input.target.file);
    const next = mergeToml(
      current,
      input.managed,
      (s) => composeServerEnv(s, input.parentEnv),
      input.removedIds,
    );
    writeAtomically(input.target.file, next);
  }

  private writeSeparateFile(input: SyncTargetInput): void {
    const dir = input.target.perServerDir;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });

    // 1. Write/refresh each managed file.
    for (const s of input.managed) {
      const env = composeServerEnv(s, input.parentEnv);
      const body: Record<string, unknown> = {
        command: s.command,
        args: s.args,
        __devia_managed: s.id,
      };
      if (Object.keys(env).length > 0) body['env'] = env;
      writeAtomically(path.join(dir, `${s.id}.json`), JSON.stringify(body, null, 2) + '\n');
    }

    // 2. Delete files for ids explicitly removed. We don't sweep the
    //    whole directory — hand-added files without the marker stay.
    for (const id of input.removedIds ?? []) {
      const file = path.join(dir, `${id}.json`);
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.__devia_managed === id) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        // Missing / malformed → nothing to clean up.
      }
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
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

function readTextSafe(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function writeAtomically(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}
