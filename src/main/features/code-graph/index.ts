import type { Feature } from '../../shared/feature';
import type { ConfigRepository } from '../../shared/ports';
import type { McpServerConfig } from '../../../shared/domain/mcp';

import { CodeGraphStore } from './infrastructure/code-graph-store';
import { CodeGraphUseCase } from './application/code-graph.use-case';
import { createWorktreeGraph } from './application/worktree-graph';
import { registerCodeGraphIpc } from './ipc/code-graph.ipc';

export { createWorktreeGraph } from './application/worktree-graph';

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
  /** Bundled code-graph MCP server for a project; null until the MCP server exists. */
  readonly codeGraphMcpServer: (projectAbs: string, agentId?: string) => McpServerConfig | null;
}

export function buildCodeGraphFeature(deps: CodeGraphDeps): CodeGraphFeatureBuilt {
  const store = new CodeGraphStore(() => deps.config.deviaDir());
  const useCase = new CodeGraphUseCase({ store });
  const { seedWorktreeGraph, dropWorktreeGraph } = createWorktreeGraph({ store, useCase });

  const feature: Feature = {
    id: 'code-graph',
    register(ctx) {
      registerCodeGraphIpc(ctx, { config: deps.config, useCase });
    },
  };

  return {
    feature,
    useCase,
    seedWorktreeGraph,
    dropWorktreeGraph,
    codeGraphMcpServer: (): McpServerConfig | null => null,
  };
}
