import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { ProjectTreeReader } from '../domain/ports';

export interface ProjectTreeIpcDeps {
  reader: ProjectTreeReader;
}

export function registerProjectTreeIpc(
  ctx: FeatureContext,
  deps: ProjectTreeIpcDeps,
): void {
  ctx.ipc.handle(
    IPC.projectTreeList,
    (_e, projectName: string, subPath?: string, force?: boolean) =>
      deps.reader.list(projectName, subPath ?? '', { force: !!force }),
  );
}
