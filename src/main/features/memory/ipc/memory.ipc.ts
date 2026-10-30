import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FeatureContext } from '../../../shared/feature';
import type { ConfigRepository } from '../../../shared/ports';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type {
  EngramDetectionResult,
  ImportEngramResult,
  MemoryScope,
  MemorySearchHit,
  MemorySearchQuery,
  Observation,
} from '../../../../shared/domain/memory';

import type { MemoryStore } from '../infrastructure/memory-store';
import type { MemoryUseCase, SearchOpts } from '../application/memory.use-case';
import type { DetectEngramUseCase } from '../application/detect-engram.use-case';
import { ImportEngramUseCase, makeNodeFileFns } from '../application/import-engram.use-case';
import { makeEngramExportRunner } from '../infrastructure/export-runner';

/**
 * IPC adapter for the Devia memory feature (S-1).
 *
 * Channels:
 *   - memory:detect-engram → DetectEngramUseCase
 *   - memory:import-engram → ImportEngramUseCase (engram export → personal store)
 *   - memory:search        → lexical search over Devia's own memory
 *   - memory:list          → recent active observations (empty-query search)
 *
 * The engram block (--strict-mcp-config) and the devia-memory server wiring
 * into the runner live in other phases; this adapter only covers detect /
 * import / read-side queries.
 */
export interface MemoryIpcDeps {
  config: ConfigRepository;
  store: MemoryStore;
  useCase: MemoryUseCase;
  detect: DetectEngramUseCase;
}

export function registerMemoryIpc(ctx: FeatureContext, deps: MemoryIpcDeps): void {
  const { config, store, useCase, detect } = deps;

  /**
   * The `devia-memory` MCP server runs out-of-process and writes the same JSON
   * files behind this store; the main-process cache would otherwise serve a
   * snapshot taken at run start (e.g. by system-prompt recall), hiding every
   * `mem_save` the agent makes during the run. Drop the cache before each
   * user-facing read/mutation so it re-reads from disk. Guarded because
   * project scope without a projectPath has no resolvable cache key.
   */
  const refresh = (scope: MemoryScope, projectPath?: string): void => {
    if (scope === 'personal' || projectPath) store.invalidate(scope, projectPath);
  };

  /**
   * The renderer sends `selectedProject()`, which is a project path RELATIVE to
   * `workspaceRoot` (e.g. "Eviatech/devia"). The `devia-memory` MCP server and
   * the runner key the per-project store by the ABSOLUTE path
   * (`path.resolve(workspaceRoot, projectName)`), so we must resolve the same
   * way here — otherwise `keyForPath` yields a different folder and the panel
   * reads an empty store while the agent's memory lives elsewhere.
   */
  const toAbsProjectPath = (projectPath?: string): string | undefined => {
    if (!projectPath) return undefined;
    const root = config.get().workspaceRoot;
    return root && !path.isAbsolute(projectPath) ? path.resolve(root, projectPath) : projectPath;
  };

  ctx.ipc.handle(IPC.memoryDetectEngram, (): EngramDetectionResult => detect.execute());

  ctx.ipc.handle(IPC.memoryImportEngram, async (): Promise<ImportEngramResult> => {
    const detection = detect.execute();
    const markImported = (at: number): void => {
      // config.set merges the memory sub-object at runtime, but the type
      // requires a full MemoryConfig — read current and spread it.
      const current = config.get().memory;
      config.set({ memory: { ...current, engramImported: true, engramImportedAt: at } });
      ctx.send('config:changed', { ...config.get(), configPath: config.configPath(), hasWorkspace: config.hasWorkspace() });
    };
    const useCaseImport = new ImportEngramUseCase(
      makeEngramExportRunner(),
      store,
      makeNodeFileFns(),
      markImported,
    );
    return useCaseImport.execute(detection.binPath);
  });

  ctx.ipc.handle(
    IPC.memorySearch,
    (_e, query: MemorySearchQuery & { projectPath?: string }): MemorySearchHit[] => {
      const projectPath = toAbsProjectPath(query.projectPath);
      const opts = buildSearchOpts({ ...query, ...(projectPath !== undefined && { projectPath }) });
      refresh(opts.scope ?? 'personal', opts.projectPath);
      return useCase.search(query.query, opts);
    },
  );

  ctx.ipc.handle(
    IPC.memoryList,
    (_e, opts?: { scope?: MemoryScope; projectPath?: string; project?: string; limit?: number }): Observation[] => {
      const projectPath = toAbsProjectPath(opts?.projectPath);
      const searchOpts = buildSearchOpts({
        query: '',
        ...(opts?.scope !== undefined && { scope: opts.scope }),
        ...(opts?.project !== undefined && { project: opts.project }),
        ...(opts?.limit !== undefined && { limit: opts.limit }),
        ...(projectPath !== undefined && { projectPath }),
      });
      refresh(searchOpts.scope ?? 'personal', searchOpts.projectPath);
      return useCase.search('', searchOpts).map((h) => h.observation);
    },
  );

  ctx.ipc.handle(
    IPC.memoryListSessions,
    (_e, opts?: { scope?: MemoryScope; projectPath?: string; project?: string; limit?: number }) => {
      const scope: MemoryScope = opts?.scope ?? 'personal';
      const projectPath = toAbsProjectPath(opts?.projectPath);
      refresh(scope, projectPath);
      const sessions = useCase.context({
        scope,
        includeAuto: true,
        ...(projectPath !== undefined && { projectPath }),
        ...(opts?.project !== undefined && { project: opts.project }),
      }).sessions;
      return opts?.limit !== undefined ? sessions.slice(0, opts.limit) : sessions;
    },
  );

  ctx.ipc.handle(
    IPC.memorySetPinned,
    (_e, args: { id: string; pinned: boolean; scope?: MemoryScope; projectPath?: string }): Observation | undefined => {
      const scope: MemoryScope = args.scope ?? 'personal';
      const projectPath = toAbsProjectPath(args.projectPath);
      refresh(scope, projectPath);
      return useCase.setPinned(args.id, args.pinned, {
        scope,
        ...(projectPath !== undefined && { projectPath }),
      });
    },
  );

  ctx.ipc.handle(
    IPC.memoryForget,
    (_e, args: { id: string; scope?: MemoryScope; projectPath?: string }): boolean => {
      const scope: MemoryScope = args.scope ?? 'personal';
      const projectPath = toAbsProjectPath(args.projectPath);
      refresh(scope, projectPath);
      return useCase.forget(args.id, {
        scope,
        ...(projectPath !== undefined && { projectPath }),
      });
    },
  );

  ctx.ipc.handle(
    IPC.memoryClear,
    (_e, args?: { scope?: MemoryScope; projectPath?: string }): boolean => {
      const scope: MemoryScope = args?.scope ?? 'personal';
      const projectPath = toAbsProjectPath(args?.projectPath);
      refresh(scope, projectPath);
      useCase.clear({
        scope,
        ...(projectPath !== undefined && { projectPath }),
      });
      return true;
    },
  );

  // Best-effort: ensure the deviaDir exists so the first read/write succeeds.
  try {
    fs.mkdirSync(config.deviaDir(), { recursive: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Build a `SearchOpts` from an IPC payload, omitting undefined optionals so the
 * call satisfies `exactOptionalPropertyTypes`. Scope defaults to 'personal'
 * (the global store where cross-project + imported engram memory lives).
 */
function buildSearchOpts(
  q: MemorySearchQuery & { projectPath?: string },
): SearchOpts {
  const scope: MemoryScope = q.scope ?? 'personal';
  return {
    scope,
    ...(q.type !== undefined && { type: q.type }),
    ...(q.project !== undefined && { project: q.project }),
    ...(q.limit !== undefined && { limit: q.limit }),
    ...(q.projectPath !== undefined && { projectPath: q.projectPath }),
  };
}
