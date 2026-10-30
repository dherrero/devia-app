import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import { bootstrap, beforeQuit, type BootstrapResult } from './composition-root';
import { IPC } from '../../shared/contracts/ipc-channels';
import { getStartupWindowState, trackWindowState, MIN_WIDTH, MIN_HEIGHT } from './window-state';
import { installContextMenu, pickSpellCheckerLanguages } from './context-menu';

// Harden stdout/stderr against EPIPE. Electron forwards renderer console
// messages to the main process console, and several features write directly to
// process.stdout/stderr (run-logger, cli-launcher dev logs). When the launching
// pipe goes away — dev terminal closed, broken pipe under output pressure — a
// write emits EPIPE on the stream; with no 'error' listener Node escalates it to
// an uncaughtException and the whole app dies (observed crash:
// `Error: write EPIPE … at console.info … WebContents`). Swallow EPIPE here so a
// dead console pipe can never take down the app; rethrow anything else.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
  });
}

// WSL2's GPU stack (WSLg → Mesa → Chromium) is known to SIGSEGV the GPU
// process intermittently, taking the whole Electron app down with it.
// Disable hardware acceleration only on WSL — native Linux, Windows and
// macOS keep the GPU path. WSL_DISTRO_NAME is set by WSL2 and is undefined
// everywhere else. Must run before app.whenReady().
const isWsl = !!process.env['WSL_DISTRO_NAME'];
if (isWsl) {
  app.disableHardwareAcceleration();
}

// Log child-process crashes (GPU, renderer, utility, pluginhost) before
// Electron tears down — Crashpad doesn't reliably capture GPU process
// SIGSEGVs in WSL, so this is our breadcrumb. Use console.error so it
// shows up under ELECTRON_ENABLE_LOGGING=1.
app.on('child-process-gone', (_event, details) => {
  console.error('[child-process-gone]', JSON.stringify({
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName,
    name: details.name,
  }));
});

let mainWindow: BrowserWindow | null = null;
let installed: BootstrapResult | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function isExternal(url: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(url);
}

function createWindow(): BrowserWindow {
  // First launch opens at 80% of the screen, centered; later launches restore
  // the last size/position the user left (see window-state.ts).
  const startup = getStartupWindowState();

  const win = new BrowserWindow({
    ...startup.bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // show:false + ready-to-show is the VS Code pattern: don't paint the
    // window until the renderer has produced its first frame, otherwise the
    // user sees an empty frameless rectangle whose drag region isn't even
    // defined yet (the -webkit-app-region CSS lives in Angular).
    show: false,
    backgroundColor: '#00000000',
    frame: false,
    titleBarStyle: 'hidden',
    // macOS-only (ignored elsewhere): keep the native traffic lights but nudge
    // them down so they centre in the 2.5rem (40px) custom titlebar. The
    // renderer reserves the left inset via --dv-safe-mac-l and paints no window
    // controls of its own on macOS.
    trafficLightPosition: { x: 16, y: 12 },
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });

  // Maximize before first paint so there is no resize flash on show.
  if (startup.isMaximized) win.maximize();
  trackWindowState(win);
  installContextMenu(win);
  if (process.platform !== 'darwin') {
    const languages = pickSpellCheckerLanguages(
      app.getPreferredSystemLanguages(),
      win.webContents.session.availableSpellCheckerLanguages,
    );
    if (languages.length > 0) win.webContents.session.setSpellCheckerLanguages(languages);
  }

  win.once('ready-to-show', () => win.show());

  // Angular build outputs to dist/renderer/browser/index.html. Resolve from
  // the project root since the compiled main lives several levels deep under
  // dist/main/main/shell.
  const isDev = process.argv.includes('--dev');
  const devRendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devRendererUrl) {
    void win.loadURL(devRendererUrl);
  } else {
    win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'browser', 'index.html'));
  }
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isExternal(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  return win;
}

ipcMain.handle(IPC.windowMinimize, () => {
  const win = getMainWindow();
  if (!win) return false;
  win.minimize();
  return true;
});

ipcMain.handle(IPC.windowToggleMaximize, () => {
  const win = getMainWindow();
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return true;
});

ipcMain.handle(IPC.windowClose, () => {
  const win = getMainWindow();
  if (!win) return false;
  win.close();
  return true;
});

ipcMain.handle(IPC.windowIsMaximized, () => {
  const win = getMainWindow();
  return win?.isMaximized() ?? false;
});

app.whenReady().then(() => {
  installed = bootstrap({ getMainWindow });
  mainWindow = createWindow();

  // Defer per-feature ready hooks until the renderer has finished its first
  // paint, so heavy work (Whisper warm-up, etc.) never competes with Angular
  // bootstrap.
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!installed) return;
      for (const feature of installed.features) {
        if (!feature.onReady) continue;
        void Promise.resolve(feature.onReady(installed.ctx)).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[feature:${feature.id}] onReady failed:`, message);
        });
      }
    }, 1500);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (installed) beforeQuit(installed.features);
});
