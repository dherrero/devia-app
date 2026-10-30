import { describe, it, expect } from 'vitest';
import { defaultBounds, resolveBounds, MIN_WIDTH, MIN_HEIGHT, type Bounds, type WindowState } from './window-state';

const FHD: Bounds = { x: 0, y: 0, width: 1920, height: 1080 };

function saved(bounds: Bounds, isMaximized = false): WindowState {
  return { bounds, isMaximized };
}

describe('defaultBounds', () => {
  it('uses 80% of the work area, centered', () => {
    const b = defaultBounds(FHD);
    expect(b.width).toBe(1536); // 1920 * 0.8
    expect(b.height).toBe(864); // 1080 * 0.8
    expect(b.x).toBe(192); // (1920 - 1536) / 2
    expect(b.y).toBe(108); // (1080 - 864) / 2
  });

  it('honors the minimum on a tiny work area', () => {
    const b = defaultBounds({ x: 0, y: 0, width: 1000, height: 700 });
    expect(b.width).toBe(MIN_WIDTH);
    expect(b.height).toBe(MIN_HEIGHT);
  });

  it('offsets the center by the work-area origin (secondary monitor)', () => {
    const b = defaultBounds({ x: 1920, y: 0, width: 1920, height: 1080 });
    expect(b.x).toBe(1920 + 192);
  });
});

describe('resolveBounds', () => {
  const displays = [FHD];

  it('falls back to the default when nothing is saved', () => {
    expect(resolveBounds(null, FHD, displays)).toEqual(defaultBounds(FHD));
  });

  it('restores saved bounds that are still visible', () => {
    const b: Bounds = { x: 100, y: 80, width: 1400, height: 900 };
    expect(resolveBounds(saved(b), FHD, displays)).toEqual(b);
  });

  it('clamps a restored size up to the minimum', () => {
    const b: Bounds = { x: 10, y: 10, width: 400, height: 300 };
    expect(resolveBounds(saved(b), FHD, displays)).toEqual({
      x: 10,
      y: 10,
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    });
  });

  it('falls back to default when the saved window is off every display', () => {
    const offscreen: Bounds = { x: 5000, y: 5000, width: 1200, height: 800 };
    expect(resolveBounds(saved(offscreen), FHD, displays)).toEqual(defaultBounds(FHD));
  });

  it('falls back to default when saved bounds are corrupt', () => {
    const corrupt = { x: 0, y: 0, width: 0, height: NaN } as Bounds;
    expect(resolveBounds(saved(corrupt), FHD, displays)).toEqual(defaultBounds(FHD));
  });

  it('keeps a window visible on a secondary display', () => {
    const second: Bounds = { x: 1920, y: 0, width: 1920, height: 1080 };
    const b: Bounds = { x: 2000, y: 100, width: 1400, height: 900 };
    expect(resolveBounds(saved(b), FHD, [FHD, second])).toEqual(b);
  });
});
