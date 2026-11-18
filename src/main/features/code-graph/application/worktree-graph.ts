import * as fs from 'node:fs';
import * as path from 'node:path';
import { isFullIndexRunning } from '../engine/db/writer-lock';
import { runSeedCopy } from './seed-copy';
import { DEFAULT_AUTO_UPDATE, type CodeGraphUseCase } from './code-graph.use-case';
import type { CodeGraphStore, ProjectDoc } from '../infrastructure/code-graph-store';

export type SeedSkipReason = 'no-base-graph' | 'base-indexing' | 'already-has-graph' | 'copy-failed' | 'worktree-missing';
export interface SeedResult {
  seeded: boolean;
  reason?: SeedSkipReason;
}

export interface WorktreeGraphDeps {
  store: CodeGraphStore;
  useCase: CodeGraphUseCase;
  /** Overrides the seed worker file (tests run the TypeScript source through a shim). */
  workerEntry?: string;
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

  const tmpFiles = (dir: string): string[] => ['', '-wal', '-shm', '-journal'].map((x) => path.join(dir, SEED_TMP) + x);

  const seed = async (baseProject: string, worktreePath: string): Promise<SeedResult> => {
    const dir = store.dataDir(worktreePath);
    try {
      if (!fs.existsSync(worktreePath)) return { seeded: false, reason: 'worktree-missing' };
      if (store.exists(worktreePath)) return { seeded: false, reason: 'already-has-graph' };
      if (!store.exists(baseProject)) return { seeded: false, reason: 'no-base-graph' };
      if (isFullIndexRunning(store.dataDir(baseProject))) return { seeded: false, reason: 'base-indexing' };
      fs.mkdirSync(dir, { recursive: true });
      for (const f of tmpFiles(dir)) fs.rmSync(f, { force: true });
      const tmp = path.join(dir, SEED_TMP);
      await runSeedCopy({ src: store.dbPath(baseProject), tmp, root: worktreePath }, deps.workerEntry);
      // The worktree may have been removed while the copy ran: never leave an orphan graph.
      if (!fs.existsSync(worktreePath)) {
        store.remove(worktreePath);
        return { seeded: false, reason: 'worktree-missing' };
      }
      if (store.exists(worktreePath)) {
        for (const f of tmpFiles(dir)) fs.rmSync(f, { force: true });
        return { seeded: false, reason: 'already-has-graph' };
      }
      const baseDoc = store.loadDoc(baseProject);
      const doc: ProjectDoc = {
        createdAt: Date.now(),
        indexedAt: baseDoc?.indexedAt ?? Date.now(),
        autoUpdate: baseDoc?.autoUpdate ?? DEFAULT_AUTO_UPDATE,
      };
      if (baseDoc?.agentAccess === false) doc.agentAccess = false;
      if (baseDoc?.builtAtCommit !== undefined) doc.builtAtCommit = baseDoc.builtAtCommit;
      // Doc first: a failure here must not leave a graph.db without its doc.
      store.saveDoc(worktreePath, doc);
      fs.renameSync(tmp, store.dbPath(worktreePath));
    } catch (err) {
      warn('seed failed', err);
      try {
        for (const f of tmpFiles(dir)) fs.rmSync(f, { force: true });
        if (!store.exists(worktreePath)) store.remove(worktreePath);
      } catch {
        // best-effort cleanup
      }
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
