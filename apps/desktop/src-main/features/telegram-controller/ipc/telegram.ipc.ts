/**
 * IPC adapter for the remote-control feature (E-DSK-14).
 *
 * Channels (all renderer→main except the `remoteControl:status` event the
 * controller emits directly):
 *   - remoteControl:get-status → current connection status
 *   - remoteControl:test       → validate a bot token (getMe)
 *   - remoteControl:restart    → re-read config and (re)start/stop the controller
 */
import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { RemoteControlStatus, TelegramTestResult } from '../../../../shared/domain/remote-control';
import type { TelegramController } from '../application/telegram-controller';

export interface TelegramControllerIpcDeps {
  controller: TelegramController;
}

export function registerTelegramControllerIpc(ctx: FeatureContext, deps: TelegramControllerIpcDeps): void {
  ctx.ipc.handle(IPC.remoteControlGetStatus, (): RemoteControlStatus => deps.controller.getStatus());

  ctx.ipc.handle(
    IPC.remoteControlTest,
    (_e, token: unknown): Promise<TelegramTestResult> => deps.controller.testToken(String(token ?? '')),
  );

  ctx.ipc.handle(IPC.remoteControlRestart, (): Promise<RemoteControlStatus> => deps.controller.restart());
}
