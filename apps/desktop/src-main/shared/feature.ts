import type { BrowserWindow, IpcMain } from 'electron';
import type { RendererEvents } from '../../shared/contracts/events';

/**
 * Strongly-typed `webContents.send` wrapper. Every channel from
 * `shared/contracts/events.ts` is enforced together with its payload shape,
 * so a feature that emits an unknown channel or the wrong payload fails to
 * compile.
 */
export type SendToRenderer = <K extends keyof RendererEvents>(
  channel: K,
  payload: RendererEvents[K],
) => void;

/**
 * Wiring handed to every feature at registration time. The composition root
 * owns the singletons (ipcMain, the main BrowserWindow, the typed send) and
 * features stay agnostic of how those are produced. `getMainWindow` is lazy
 * so features whose IPC registration runs before `createWindow()` still work.
 */
export interface FeatureContext {
  readonly ipc: IpcMain;
  readonly send: SendToRenderer;
  getMainWindow(): BrowserWindow | null;
}

/**
 * Every product module implements this. The composition root iterates an
 * array of `Feature` instances and registers only the ones enabled by the
 * current license flags — that filter is the seam between the codebase and
 * the future modular monetization plan.
 */
export interface Feature {
  readonly id: string;
  register(ctx: FeatureContext): void;
  onReady?(ctx: FeatureContext): Promise<void> | void;
  onBeforeQuit?(): void;
}
