import { screen, type BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Window size/position persistence. The shell owns the BrowserWindow
 * lifecycle, so window bounds live here in their own `window-state.json`
 * rather than in `state.json` (a cross-feature aggregate) or the config
 * cache (a separate short-lived FsConfigRepository reads it in createWindow,
 * which would race the singleton's cache on write).
 *
 * First launch: open at 80% of the primary display's work area, centered.
 * Afterwards: reopen at the size/position the user left it, never below the
 * minimum and only if still visible on a connected display.
 */

export const MIN_WIDTH = 900;
export const MIN_HEIGHT = 600;

// Fraction of the work area used on first launch (no saved bounds).
const TARGET_FRACTION = 0.8;

// A restored window must keep at least this much of itself on some display so
// the user can always grab it after a monitor is unplugged or resolution changes.
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 60;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: Bounds;
  isMaximized: boolean;
}

function isValidBounds(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    Number.isFinite(b['x'])
    && Number.isFinite(b['y'])
    && typeof b['width'] === 'number' && b['width'] > 0
    && typeof b['height'] === 'number' && b['height'] > 0
  );
}

function overlap(a: Bounds, b: Bounds): { w: number; h: number } {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return { w, h };
}

function intersectsAnyDisplay(bounds: Bounds, displays: Bounds[]): boolean {
  return displays.some((d) => {
    const o = overlap(bounds, d);
    return o.w >= MIN_VISIBLE_WIDTH && o.h >= MIN_VISIBLE_HEIGHT;
  });
}

/** 80% of the work area, centered within it. Honors the minimum window size. */
export function defaultBounds(workArea: Bounds): Bounds {
  const width = Math.max(Math.round(workArea.width * TARGET_FRACTION), MIN_WIDTH);
  const height = Math.max(Math.round(workArea.height * TARGET_FRACTION), MIN_HEIGHT);
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  return { x, y, width, height };
}

/**
 * Pure resolution: restore the saved bounds when they are valid and still
 * visible on a connected display, otherwise fall back to the first-launch
 * default. Restored sizes are clamped up to the minimum.
 */
export function resolveBounds(
  saved: WindowState | null,
  workArea: Bounds,
  displays: Bounds[],
): Bounds {
  const b = saved?.bounds;
  if (b && isValidBounds(b) && intersectsAnyDisplay(b, displays)) {
    return {
      x: b.x,
      y: b.y,
      width: Math.max(b.width, MIN_WIDTH),
      height: Math.max(b.height, MIN_HEIGHT),
    };
  }
  return defaultBounds(workArea);
}

function stateFilePath(): string {
  return path.join(os.homedir(), '.devia-app', 'window-state.json');
}

function readWindowState(): WindowState | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const data = raw as Record<string, unknown>;
    if (!isValidBounds(data['bounds'])) return null;
    return {
      bounds: data['bounds'],
      isMaximized: data['isMaximized'] === true,
    };
  } catch {
    return null;
  }
}

function writeWindowState(state: WindowState): void {
  try {
    const file = stateFilePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[window-state] save failed:', message);
  }
}

/** Bounds + maximized flag to apply when constructing the BrowserWindow. */
export function getStartupWindowState(): { bounds: Bounds; isMaximized: boolean } {
  const saved = readWindowState();
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  return {
    bounds: resolveBounds(saved, primary.workArea, displays),
    isMaximized: saved?.isMaximized ?? false,
  };
}

/**
 * Persist size/position on resize and move (debounced) and once more on close.
 * Uses getNormalBounds() so a maximized/minimized window still records the
 * underlying restored size, with the maximized state captured separately.
 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const persist = (): void => {
    if (win.isDestroyed()) return;
    writeWindowState({ bounds: win.getNormalBounds(), isMaximized: win.isMaximized() });
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 400);
  };

  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    persist();
  });
}
