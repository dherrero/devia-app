/**
 * Remote-control feature (E-DSK-14): drive the desktop app from Telegram while
 * it is open, via an embedded controller in the main process (no daemon).
 *
 * Lifecycle: the controller starts on `onReady` (when the user has enabled
 * Telegram in Settings) and stops on `onBeforeQuit`. The renderer reconfigures
 * it through `remoteControl:restart` after editing the settings.
 *
 * This feature only owns the connection + dispatch; the command router and the
 * run integration (Fase C) are injected via `onMessage` so this layer stays
 * decoupled from claude-runner and workspace.
 */
import { powerMonitor, powerSaveBlocker } from 'electron';
import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository } from '../../shared/ports';
import { TelegramController, type RemoteMessageHandler } from './application/telegram-controller';
import { registerTelegramControllerIpc } from './ipc/telegram.ipc';

export { TelegramController } from './application/telegram-controller';
export type { IncomingMessage, RemoteMessageHandler } from './application/telegram-controller';
export { TelegramClient } from './infrastructure/telegram-client';
export {
  createCommandRouter,
  ConfigActiveProjectStore,
  type ActiveProjectStore,
  type RemoteCommandPorts,
} from './application/command-router';
export { createShellRunner, type ShellRunner } from './infrastructure/shell-runner';

export interface TelegramControllerFeatureDeps {
  config: ConfigRepository;
  /**
   * Authorised-message handler. Injected by the composition root (Fase C wires
   * the command router). When absent, a built-in help/ack handler is used.
   */
  onMessage?: RemoteMessageHandler;
}

export interface TelegramControllerFeatureBuilt {
  readonly feature: Feature;
  /** Exposed so other features (e.g. the run mirror in Fase C) can push
   *  notifications to the chat without re-deriving the controller. */
  readonly controller: TelegramController;
}

export function buildTelegramControllerFeature(
  deps: TelegramControllerFeatureDeps,
): TelegramControllerFeatureBuilt {
  let controller: TelegramController | null = null;

  // Held only while the bot is connected, so the OS doesn't idle-sleep the app
  // and freeze the long-poll. 'prevent-app-suspension' keeps the process alive
  // while still letting the display sleep. Released as soon as the bot stops.
  // (Clamshell sleep on battery is OS-enforced and can't be blocked this way.)
  let blockerId: number | null = null;
  const acquireBlocker = (): void => {
    if (blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  };
  const releaseBlocker = (): void => {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  };

  // On wake from OS sleep the long-poll socket is dead; nudge the poller to
  // reconnect at once instead of waiting out its request timeout.
  const onResume = (): void => controller?.wake();

  const feature: Feature = {
    id: 'telegram-controller',
    register(ctx: FeatureContext) {
      controller = new TelegramController({
        config: deps.config,
        emitStatus: (status) => ctx.send('remoteControl:status', status),
        onActive: acquireBlocker,
        onInactive: releaseBlocker,
        ...(deps.onMessage !== undefined && { onMessage: deps.onMessage }),
      });
      registerTelegramControllerIpc(ctx, { controller });
    },
    onReady() {
      void controller?.start();
      powerMonitor.on('resume', onResume);
    },
    onBeforeQuit() {
      powerMonitor.removeListener('resume', onResume);
      controller?.stop();
      releaseBlocker();
    },
  };

  // The controller instance is created lazily in register(); expose a stable
  // accessor object so callers always reach the live instance.
  return {
    feature,
    get controller(): TelegramController {
      if (!controller) throw new Error('telegram-controller not registered yet');
      return controller;
    },
  };
}
