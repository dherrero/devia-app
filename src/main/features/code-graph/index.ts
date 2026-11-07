import type { Feature } from '../../shared/feature';
import type { ConfigRepository } from '../../shared/ports';
import type { McpServerConfig } from '../../../shared/domain/mcp';

import { CodeGraphStore } from './infrastructure/code-graph-store';
import { CodeGraphUseCase } from './application/code-graph.use-case';

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
  /** Bundled code-graph MCP server for a project; null until the MCP server exists. */
  readonly codeGraphMcpServer: (projectAbs: string, agentId?: string) => McpServerConfig | null;
}

export function buildCodeGraphFeature(deps: CodeGraphDeps): CodeGraphFeatureBuilt {
  const store = new CodeGraphStore(() => deps.config.deviaDir());
  const useCase = new CodeGraphUseCase({ store });

  const feature: Feature = {
    id: 'code-graph',
    register() {
      // IPC channels are registered here once they exist.
    },
  };

  return {
    feature,
    useCase,
    codeGraphMcpServer: (): McpServerConfig | null => null,
  };
}
