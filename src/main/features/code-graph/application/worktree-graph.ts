import * as fs from 'node:fs';
import * as path from 'node:path';
import { openGraphDb } from '../engine/db/connection';
import { GraphQueries } from '../engine/db/queries';
import { isFullIndexRunning } from '../engine/db/writer-lock';
import { DEFAULT_AUTO_UPDATE, type CodeGraphUseCase } from './code-graph.use-case';
import type { CodeGraphStore, ProjectDoc } from '../infrastructure/code-graph-store';

export type SeedSkipReason = 'no-base-graph' | 'base-indexing' | 'already-has-graph' | 'copy-failed';
export interface SeedResult {
  seeded: boolean;
  reason?: SeedSkipReason;
}

export interface WorktreeGraphDeps {
  store: CodeGraphStore;
  useCase: CodeGraphUseCase;
}

const SEED_TMP = 'graph.db.seed.tmp';

const warn = (what: string, err: unknown): void =>
  console.warn(`[code-graph:worktree] ${what}:`, err instanceof Error ? err.message : String(err));

/**
 * An isolated pane runs in a git worktree whose graph the agent reads. Paths in
 * the DB are relative to the project root, so the base graph is valid in the
 * worktree as-is; seeding it lets the first sync reprocess only the differences
 * instead of re-indexing the whole checkout.
 */
export function createWorktreeGraph(deps: WorktreeGraphDeps): {
  seedWorktreeGraph(args: { baseProject: string; worktreePath: string }): Promise<SeedResult>;
  dropWorktreeGraph(worktreePath: string): Promise<void>;
} {
  const { store, useCase } = deps;
  const seeding = new Map<string, Promise<unknown>>();

  const copyGraph = (baseProject: string, worktreePath: string): void => {
    const dir = store.dataDir(worktreePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, SEED_TMP);
    const cleanup = (): void => {
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(tmp + suffix, { force: true });
    };
    cleanup();
    try {
      // VACUUM INTO yields a consistent snapshot even with a live WAL reader/writer.
      const src = openGraphDb(store.dbPath(baseProject), { readonly: true });
      try {
        src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      } finally {
        src.close();
      }
      const copy = openGraphDb(tmp);
      try {
        // The copied root is the base path; sync treats a different root as "full index required".
        new GraphQueries(copy).setMeta('root', worktreePath);
        copy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        copy.close();
      }
      for (const suffix of ['-wal', '-shm']) fs.rmSync(tmp + suffix, { force: true });
      if (store.exists(worktreePath)) {
        cleanup();
        return;
      }
      fs.renameSync(tmp, store.dbPath(worktreePath));
    } catch (err) {
      cleanup();
      throw err;
    }
  };

  const seed = async (baseProject: string, worktreePath: string): Promise<SeedResult> => {
    if (store.exists(worktreePath)) return { seeded: false, reason: 'already-has-graph' };
    if (!store.exists(baseProject)) return { seeded: false, reason: 'no-base-graph' };
    if (isFullIndexRunning(store.dataDir(baseProject))) return { seeded: false, reason: 'base-indexing' };
    try {
      copyGraph(baseProject, worktreePath);
      const baseDoc = store.loadDoc(baseProject);
      const doc: ProjectDoc = {
        createdAt: Date.now(),
        indexedAt: baseDoc?.indexedAt ?? Date.now(),
        autoUpdate: baseDoc?.autoUpdate ?? DEFAULT_AUTO_UPDATE,
      };
      if (baseDoc?.agentAccess === false) doc.agentAccess = false;
      if (baseDoc?.builtAtCommit !== undefined) doc.builtAtCommit = baseDoc.builtAtCommit;
      store.saveDoc(worktreePath, doc);
    } catch (err) {
      warn('seed failed', err);
      return { seeded: false, reason: 'copy-failed' };
    }
    useCase.syncNow(worktreePath).catch((err: unknown) => warn('background sync failed', err));
    return { seeded: true };
  };

  return {
    seedWorktreeGraph({ baseProject, worktreePath }) {
      const running = seeding.get(worktreePath);
      if (running) return running as Promise<SeedResult>;
      const p = seed(baseProject, worktreePath).finally(() => seeding.delete(worktreePath));
      seeding.set(worktreePath, p);
      return p;
    },
    async dropWorktreeGraph(worktreePath) {
      try {
        await seeding.get(worktreePath);
        await useCase.reset(worktreePath);
      } catch (err) {
        warn('drop failed', err);
      }
    },
  };
}
