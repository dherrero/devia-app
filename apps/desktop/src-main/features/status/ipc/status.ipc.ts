import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { GetStatusUseCase } from '../application/get-status.use-case';

export interface StatusIpcDeps {
  getStatus: GetStatusUseCase;
}

export function registerStatusIpc(ctx: FeatureContext, deps: StatusIpcDeps): void {
  ctx.ipc.handle(IPC.statusGet, () => deps.getStatus.execute());
}
