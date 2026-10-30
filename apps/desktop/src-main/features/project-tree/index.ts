import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository } from '../../shared/ports';

import { FsProjectTreeReader } from './infrastructure/fs-project-tree-reader';
import { registerProjectTreeIpc } from './ipc/project-tree.ipc';
import type { ProjectTreeReader } from './domain/ports';

export type { ProjectTreeReader } from './domain/ports';
export { FsProjectTreeReader } from './infrastructure/fs-project-tree-reader';

export interface ProjectTreeDeps {
  config: ConfigRepository;
}

export interface ProjectTreeExports {
  reader: ProjectTreeReader;
  /** Drops the cached git snapshot for a project so the next list() call
   *  returns fresh state. The git feature wires this into its watcher. */
  invalidate(projectName: string): void;
}

export interface BuiltProjectTreeFeature {
  feature: Feature;
  exports: ProjectTreeExports;
}

export function buildProjectTreeFeature(deps: ProjectTreeDeps): BuiltProjectTreeFeature {
  const reader = new FsProjectTreeReader(deps.config);

  const feature: Feature = {
    id: 'project-tree',
    register(ctx: FeatureContext) {
      registerProjectTreeIpc(ctx, { reader });
    },
  };

  return {
    feature,
    exports: {
      reader,
      invalidate: (projectName: string) => reader.invalidate(projectName),
    },
  };
}
