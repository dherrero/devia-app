import type { Feature } from '../../shared/feature';
import type { ConfigRepository } from '../../shared/ports';
import type { McpServerConfig } from '../../../shared/domain/mcp';

import { CodeGraphStore } from './infrastructure/code-graph-store';
import { CodeGraphUseCase } from './application/code-graph.use-case';
import { GraphViewUseCase } from './application/graph-view.use-case';
import { createWorktreeGraph } from './application/worktree-graph';
import { registerCodeGraphIpc } from './ipc/code-graph.ipc';
import { CodeGraphMcpInjector } from './mcp-server/code-graph-mcp-injector';

export { createWorktreeGraph } from './application/worktree-graph';
export { CODE_GRAPH_SERVER_ID, CodeGraphMcpInjector } from './mcp-server/code-graph-mcp-injector';

/**
 * Code Graph feature (S-44): per-project code knowledge graph indexed in a
 * worker thread. State lives in `~/.devia-app/code-graph/<projectKey>/`
 * (graph.db + project.json) — never inside the user's repo.
 */
export interface CodeGraphDeps {
  config: ConfigRepository;
}

export interface CodeGraphFeatureBuilt {
  readonly feature: Feature;
  readonly useCase: CodeGraphUseCase;
  /** Seeds a new worktree's graph from its base project / drops it with the worktree. */
  readonly seedWorktreeGraph: (args: { baseProject: string; worktreePath: string }) => Promise<{ seeded: boolean; reason?: string }>;
  readonly dropWorktreeGraph: (worktreePath: string) => Promise<void>;
  /**
   * The bundled `devia-code-graph` MCP server for the run's EFFECTIVE cwd (a
   * worktree with its own graph, else the checkout), or null when that exact
   * path has no graph or the user turned agent access off.
   */
  readonly codeGraphMcpServer: (projectAbs: string, agentId?: string) => McpServerConfig | null;
  /** Same decision as `codeGraphMcpServer`, as a boolean. */
  readonly codeGraphServerRegistered: (projectAbs: string) => boolean;
}

export function buildCodeGraphFeature(deps: CodeGraphDeps): CodeGraphFeatureBuilt {
  const store = new CodeGraphStore(() => deps.config.deviaDir());
  const useCase = new CodeGraphUseCase({ store });
  const view = new GraphViewUseCase({ store });
  const { seedWorktreeGraph, dropWorktreeGraph } = createWorktreeGraph({ store, useCase });
  const injector = new CodeGraphMcpInjector(() => deps.config.deviaDir());

  // Read once when a run starts: the agent's MCP set is fixed for the whole
  // run, so the switch (or a graph built mid-run) takes effect on the next one.
  // No fallback to the base graph for a worktree: it describes other files.
  const codeGraphMcpServer = (projectAbs: string, agentId?: string): McpServerConfig | null => {
    try {
      if (!store.exists(projectAbs) || store.loadDoc(projectAbs)?.agentAccess === false) return null;
      return injector.serverConfig(projectAbs, agentId);
    } catch (err: unknown) {
      // A graph problem must never stop an agent run.
      console.warn('[code-graph] MCP server not offered to this run:', err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const feature: Feature = {
    id: 'code-graph',
    register(ctx) {
      registerCodeGraphIpc(ctx, { config: deps.config, useCase, view });
    },
  };

  return {
    feature,
    useCase,
    seedWorktreeGraph,
    dropWorktreeGraph,
    codeGraphMcpServer,
    codeGraphServerRegistered: (projectAbs: string): boolean => codeGraphMcpServer(projectAbs) !== null,
  };
}
