import * as fs from 'node:fs';

import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository } from '../../shared/ports';
import type { McpServerConfig } from '../../../shared/domain/mcp';
import type { MemoryRecall } from '../../../shared/domain/memory';

import { MemoryStore } from './infrastructure/memory-store';
import { migrateWorktreeMemoryStores } from './infrastructure/worktree-memory-migration';
import { scanProjectMcpForMemory } from './infrastructure/external-memory-catalog';
import { MemoryUseCase } from './application/memory.use-case';
import { DetectEngramUseCase, makeSpawnSyncRunner } from './application/detect-engram.use-case';
import { MemoryMcpInjector } from './mcp-server/memory-mcp-injector';
import { registerMemoryIpc } from './ipc/memory.ipc';

/**
 * Devia internal memory feature (S-1).
 *
 * Bundles a JSON-backed memory store, the `devia-memory` MCP server config
 * builder (delivered to Claude via the runner's --mcp-config and injected into
 * other agents' native config), engram detection, and a one-shot engram import.
 * State lives in `~/.devia-app/` (personal `memory-global.json` + per-project
 * `memory.json`) — never inside the user's repo.
 */
export interface MemoryDeps {
  config: ConfigRepository;
}

export interface MemoryFeatureBuilt {
  readonly feature: Feature;
  /** Builds the bundled devia-memory MCP server config for a project, so the
   *  Claude runner can deliver it via `--mcp-config` (mirrors kanbanMcpServer). */
  readonly memoryMcpServer: (projectAbs: string, agentId?: string) => McpServerConfig;
  /** Injector for non-Claude agents (writes devia-memory into their native
   *  MCP config). Consumed by the runner/agent-select wiring (T-14). */
  readonly memoryMcpInjector: MemoryMcpInjector;
  /** Task-aware project memory recall for system-prompt pre-injection
   *  (E-DSK-13 phase A + #314): observations relevant to the current prompt +
   *  recent summaries. Thin wrapper over MemoryUseCase.recall so the runner
   *  stays decoupled from this feature's internals. */
  readonly memoryContext: (projectPath: string, query: string) => MemoryRecall;
  /** Labels of known THIRD-PARTY memory MCP servers found in the project's
   *  `.mcp.json` (E-DSK-13 #322), for a provider-neutral coexistence warning. */
  readonly detectExternalMemory: (projectPath: string) => string[];
  /** Passive-capture sinks (E-DSK-13 phase C): record a user prompt / an auto
   *  run summary into project-scope memory. Thin wrappers over MemoryUseCase. */
  readonly saveMemoryPrompt: (projectPath: string, content: string, sessionId?: string, agentId?: string) => void;
  readonly saveMemorySummary: (
    projectPath: string,
    content: string,
    sessionId?: string,
    startedAt?: number,
    agentId?: string,
  ) => void;
  /** Cross-agent handoff record (S-2 F2.2): NOT auto (must enter recall) and
   *  appended standalone so run summaries never overwrite it. */
  readonly saveMemoryHandoff: (
    projectPath: string,
    content: string,
    sessionId?: string,
    agentId?: string,
  ) => void;
  /** S-2 F3.4: fresh rich summary a specific agent recorded for a session. */
  readonly recentHandoffSummary: (
    projectPath: string,
    sessionId: string,
    agentId: string,
    maxAgeMs: number,
  ) => string | null;
}

export function buildMemoryFeature(deps: MemoryDeps): MemoryFeatureBuilt {
  const deviaDir = (): string => deps.config.deviaDir();
  const store = new MemoryStore(deviaDir);
  const useCase = new MemoryUseCase(store);
  const injector = new MemoryMcpInjector(deviaDir);
  const detect = new DetectEngramUseCase(makeSpawnSyncRunner(), (p) => fs.existsSync(p));

  const feature: Feature = {
    id: 'memory',
    register(ctx: FeatureContext) {
      // Fold session-worktree-keyed orphan stores back into their base
      // project's memory.json (one-shot per orphan; merged files are renamed
      // to .migrated). Runs before any read so the startup cache stays clean.
      try {
        const migrated = migrateWorktreeMemoryStores(deviaDir());
        if (migrated.mergedStores > 0) {
          console.log(
            `[devia:memory] merged ${migrated.mergedStores} session-worktree memory store(s) into base projects ` +
              `(${migrated.observations} observations, ${migrated.sessions} sessions, ${migrated.prompts} prompts)`,
          );
        }
      } catch (err: unknown) {
        console.warn(
          '[devia:memory] worktree memory migration failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      registerMemoryIpc(ctx, { config: deps.config, store, useCase, detect });
    },
  };

  return {
    feature,
    memoryMcpServer: (projectAbs: string, agentId?: string): McpServerConfig =>
      injector.serverConfig(projectAbs, agentId),
    memoryMcpInjector: injector,
    memoryContext: (projectPath: string, query: string): MemoryRecall =>
      // E-DSK-13 #314: task-aware recall (relevant observations + recent
      // summaries). #5: auto summaries stay excluded (recall → context uses
      // includeAuto:false), so the feed favours curated, agent-authored memory.
      useCase.recall({ projectPath, query }),
    detectExternalMemory: (projectPath: string): string[] =>
      scanProjectMcpForMemory(projectPath).map((e) => e.label),
    saveMemoryPrompt: (projectPath: string, content: string, sessionId?: string, agentId?: string): void => {
      useCase.savePrompt({
        content,
        projectPath,
        ...(sessionId !== undefined && { sessionId }),
        ...(agentId !== undefined && { agentId }),
      });
    },
    saveMemorySummary: (projectPath: string, content: string, sessionId?: string, startedAt?: number, agentId?: string): void => {
      // E-DSK-13 #5: mark as auto so it is captured for search/audit but kept
      // out of the system-prompt pre-injection. #318: pass the real run start so
      // the upsert (by sessionId) records a real session span.
      useCase.sessionSummary({
        content,
        projectPath,
        auto: true,
        ...(sessionId !== undefined && { sessionId }),
        ...(startedAt !== undefined && { startedAt }),
        ...(agentId !== undefined && { agentId }),
      });
    },
    saveMemoryHandoff: (projectPath: string, content: string, sessionId?: string, agentId?: string): void => {
      useCase.sessionSummary({
        content,
        projectPath,
        kind: 'handoff',
        ...(sessionId !== undefined && { sessionId }),
        ...(agentId !== undefined && { agentId }),
      });
    },
    recentHandoffSummary: (projectPath: string, sessionId: string, agentId: string, maxAgeMs: number): string | null => {
      // The MCP server writes out-of-process — drop the cache before reading
      // so the agent's just-recorded summary is visible (same gotcha as the
      // memory IPC handlers).
      store.invalidate('project', projectPath);
      return useCase.recentSessionSummary({ sessionId, agentId, maxAgeMs, projectPath });
    },
  };
}

export { MemoryStore } from './infrastructure/memory-store';
export { MemoryUseCase } from './application/memory.use-case';
export { MemoryMcpInjector } from './mcp-server/memory-mcp-injector';
