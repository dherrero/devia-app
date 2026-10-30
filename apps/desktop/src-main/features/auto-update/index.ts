import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { Feature, FeatureContext } from '../../shared/feature';
import { IPC } from '../../../shared/contracts/ipc-channels';
import type { UpdateStatus } from '../../../shared/domain/update';

/**
 * Minimal slice of electron-updater's `autoUpdater` that this feature touches.
 * Declaring it lets a unit test inject a fake without dragging in the real
 * singleton (which reaches the network and the packaged `app-update.yml`).
 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface AutoUpdateDeps {
  updater?: UpdaterLike;
  /** Defaults to `app.isPackaged`. In dev there is no `app-update.yml`, so the
   *  updater would throw on every check — gate all network work on this. */
  isPackaged?: boolean;
}

const INITIAL_DELAY_MS = 10_000;
const PERIODIC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Strip absolute filesystem paths / URLs so no host detail leaks to the
 *  renderer (and on to logs). */
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/(?:[A-Za-z]:\\|\/)\S+/g, '<path>').slice(0, 300);
}

export function buildAutoUpdateFeature(deps: AutoUpdateDeps = {}): Feature {
  const updater = deps.updater ?? (autoUpdater as unknown as UpdaterLike);
  const isPackaged = deps.isPackaged ?? app.isPackaged;

  // Set in register() (always called before onReady / any IPC), so check()'s
  // error path and the event listeners can rely on it.
  let emit!: (status: UpdateStatus) => void;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let periodicTimer: ReturnType<typeof setInterval> | null = null;

  async function check(): Promise<void> {
    // Linux .deb (and any non-AppImage target) has no updater backend, so a
    // check throws — surface it as a status instead of crashing the run.
    try {
      await updater.checkForUpdates();
    } catch (err) {
      emit({ state: 'error', error: sanitizeError(err) });
    }
  }

  return {
    id: 'auto-update',

    register(ctx: FeatureContext) {
      emit = (status) => ctx.send(IPC.updateStatus, status);

      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;

      updater.on('checking-for-update', () => emit({ state: 'checking' }));
      updater.on('update-available', (...args) => {
        const version = (args[0] as { version?: string } | undefined)?.version;
        emit(version ? { state: 'available', version } : { state: 'available' });
      });
      updater.on('update-not-available', () => emit({ state: 'not-available' }));
      updater.on('download-progress', (...args) => {
        const percent = (args[0] as { percent?: number } | undefined)?.percent ?? 0;
        emit({ state: 'downloading', percent: Math.round(percent) });
      });
      updater.on('update-downloaded', (...args) => {
        const version = (args[0] as { version?: string } | undefined)?.version;
        emit(version ? { state: 'downloaded', version } : { state: 'downloaded' });
      });
      updater.on('error', (...args) => emit({ state: 'error', error: sanitizeError(args[0]) }));

      ctx.ipc.handle(IPC.updateCheck, async () => {
        if (isPackaged) await check();
      });
      ctx.ipc.handle(IPC.updateInstall, () => {
        if (isPackaged) updater.quitAndInstall();
      });
    },

    onReady() {
      if (!isPackaged) return;
      initialTimer = setTimeout(() => void check(), INITIAL_DELAY_MS);
      periodicTimer = setInterval(() => void check(), PERIODIC_INTERVAL_MS);
    },

    onBeforeQuit() {
      if (initialTimer) clearTimeout(initialTimer);
      if (periodicTimer) clearInterval(periodicTimer);
    },
  };
}
