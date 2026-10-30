import type { Feature, FeatureContext } from '../../shared/feature';
import type {
  GitInspector,
  ProjectRegistry,
} from '../../shared/ports';

import { GetStatusUseCase } from './application/get-status.use-case';
import { registerStatusIpc } from './ipc/status.ipc';

export interface StatusDeps {
  registry: ProjectRegistry;
  git: GitInspector;
}

export function buildStatusFeature(deps: StatusDeps): Feature {
  const getStatus = new GetStatusUseCase(deps);
  return {
    id: 'status',
    register(ctx: FeatureContext) {
      registerStatusIpc(ctx, { getStatus });
    },
  };
}
