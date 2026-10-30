import { Injectable, computed, signal } from '@angular/core';

export const RENDERER_ZOOM_STORAGE_KEY = 'devia.renderer.zoom';
export const RENDERER_ZOOM_DEFAULT = 100;
export const RENDERER_ZOOM_MIN = 80;
export const RENDERER_ZOOM_MAX = 140;
export const RENDERER_ZOOM_STEP = 10;

@Injectable({ providedIn: 'root' })
export class RendererZoomService {
  private readonly _percent = signal(resolveStoredRendererZoom());

  readonly percent = this._percent.asReadonly();
  readonly label = computed(() => `${this._percent()}%`);
  readonly canDecrease = computed(() => this._percent() > RENDERER_ZOOM_MIN);
  readonly canIncrease = computed(() => this._percent() < RENDERER_ZOOM_MAX);

  constructor() {
    applyRendererZoom(this._percent());
  }

  decrease(): void {
    this.setPercent(this._percent() - RENDERER_ZOOM_STEP);
  }

  increase(): void {
    this.setPercent(this._percent() + RENDERER_ZOOM_STEP);
  }

  reset(): void {
    this.setPercent(RENDERER_ZOOM_DEFAULT);
  }

  setPercent(percent: number): void {
    const next = normalizeRendererZoom(percent);
    this._percent.set(next);
    persistRendererZoom(next);
    applyRendererZoom(next);
  }
}

export function normalizeRendererZoom(percent: number): number {
  if (!Number.isFinite(percent)) return RENDERER_ZOOM_DEFAULT;

  const stepped =
    Math.round(percent / RENDERER_ZOOM_STEP) * RENDERER_ZOOM_STEP;
  return Math.min(RENDERER_ZOOM_MAX, Math.max(RENDERER_ZOOM_MIN, stepped));
}

export function resolveStoredRendererZoom(): number {
  try {
    return normalizeRendererZoom(
      Number.parseInt(localStorage.getItem(RENDERER_ZOOM_STORAGE_KEY) ?? '', 10),
    );
  } catch {
    return RENDERER_ZOOM_DEFAULT;
  }
}

export function persistRendererZoom(percent: number): void {
  try {
    localStorage.setItem(RENDERER_ZOOM_STORAGE_KEY, String(percent));
  } catch {
    /* private mode or locked storage: keep the in-memory zoom only */
  }
}

export function applyRendererZoom(percent: number): void {
  document.documentElement.style.fontSize = `${normalizeRendererZoom(percent)}%`;
}
