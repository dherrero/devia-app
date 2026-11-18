import { afterEach, describe, expect, it, vi } from 'vitest';

import { NODE_KINDS, type GraphOverviewNode } from '../../../../../shared/domain/code-graph';
import {
  COMMUNITY_PALETTE, LABEL_ZOOM_THRESHOLD, NEUTRAL_COLOR, edgeOpacity, edgeWidth, graphStyle, refreshTheme, resolveStyleVars,
  shapeLegend, zoomedLabelSize,
} from './graph-style';

function node(over: Partial<GraphOverviewNode> = {}): GraphOverviewNode {
  return { id: 'n', kind: 'file', label: 'n.ts', childCount: 0, path: 'src/n.ts', ...over };
}

const HEX = /#[0-9a-f]{3,8}\b/i;

describe('graphStyle (S-44 T-510)', () => {
  it('maps the same community to the same colour, stably modulo the palette', () => {
    expect(graphStyle(node({ community: 3 })).color).toBe(graphStyle(node({ id: 'other', kind: 'dir', community: 3 })).color);
    expect(graphStyle(node({ community: 3 })).color).toBe(COMMUNITY_PALETTE[3]);
    expect(graphStyle(node({ community: 3 + COMMUNITY_PALETTE.length })).color).toBe(COMMUNITY_PALETTE[3]);
    expect(graphStyle(node({ community: 1 })).color).not.toBe(graphStyle(node({ community: 2 })).color);
  });

  it('uses a neutral colour when there is no community', () => {
    expect(graphStyle(node()).color).toBe(NEUTRAL_COLOR);
    expect(graphStyle(node({ community: -1 })).color).toBe(NEUTRAL_COLOR);
  });

  it('keeps the palette at 12 or fewer tokens', () => {
    expect(COMMUNITY_PALETTE.length).toBeGreaterThan(1);
    expect(COMMUNITY_PALETTE.length).toBeLessThanOrEqual(12);
    expect(new Set(COMMUNITY_PALETTE).size).toBe(COMMUNITY_PALETTE.length);
  });

  it('returns CSS custom property names, never hex literals', () => {
    for (const s of [graphStyle(node({ community: 0, hub: true })), graphStyle(node({ kind: 'dir' }))]) {
      expect(s.color).toMatch(/^--dv-[a-z0-9-]+$/);
      expect(JSON.stringify(s)).not.toMatch(HEX);
    }
    for (const v of [...COMMUNITY_PALETTE, NEUTRAL_COLOR]) expect(v).toMatch(/^--dv-[a-z0-9-]+$/);
  });

  it('maps kinds to shapes: dir round-rectangle, file rectangle, types ellipse variants, callables small ellipse', () => {
    expect(graphStyle(node({ kind: 'dir' })).shape).toBe('round-rectangle');
    expect(graphStyle(node({ kind: 'file' })).shape).toBe('rectangle');
    expect(graphStyle(node({ kind: 'class' })).shape).toBe('ellipse');
    for (const kind of ['interface', 'enum', 'component'] as const) {
      expect(graphStyle(node({ kind })).shape).toMatch(/ellipse|round-/);
    }
    expect(graphStyle(node({ kind: 'function' })).shape).toBe('ellipse');
    expect(graphStyle(node({ kind: 'function' })).size).toBeLessThan(graphStyle(node({ kind: 'class' })).size);
    expect(graphStyle(node({ kind: 'variable' })).shape).toBeTruthy();
  });

  it('draws a dir larger than a file with the same counts', () => {
    expect(graphStyle(node({ kind: 'dir', childCount: 4 })).size).toBeGreaterThan(graphStyle(node({ kind: 'file', childCount: 4 })).size);
  });

  it('grows with symbolCount/childCount on a log scale and clamps both ends', () => {
    const s0 = graphStyle(node({ kind: 'dir', childCount: 0 })).size;
    const s10 = graphStyle(node({ kind: 'dir', childCount: 10 })).size;
    const s100 = graphStyle(node({ kind: 'dir', childCount: 100 })).size;
    const huge = graphStyle(node({ kind: 'dir', childCount: 1e9 })).size;
    expect(s10).toBeGreaterThan(s0);
    expect(s100).toBeGreaterThan(s10);
    expect(s100 - s10).toBeLessThan((s10 - s0) * 10);
    expect(huge).toBe(graphStyle(node({ kind: 'dir', childCount: 1e12 })).size);
    expect(graphStyle(node({ kind: 'dir', childCount: -5 })).size).toBe(s0);
    expect(graphStyle(node({ kind: 'file', symbolCount: 50, childCount: 1 })).size)
      .toBeGreaterThan(graphStyle(node({ kind: 'file', childCount: 1 })).size);
  });

  it('draws hubs bigger and with a ring', () => {
    const plain = graphStyle(node({ community: 2 }));
    const hub = graphStyle(node({ community: 2, hub: true }));
    expect(hub.size).toBeGreaterThan(plain.size);
    expect(hub.ring).toBe(true);
    expect(plain.ring).toBe(false);
  });
});

describe('shapeLegend (S-44 T-510)', () => {
  it('lists every shape graphStyle produces, once, and nothing else', () => {
    const produced = new Set([...NODE_KINDS, 'dir' as const].map((kind) => graphStyle(node({ kind })).shape));
    const listed = shapeLegend().map((entry) => entry.shape);
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(listed)).toEqual(produced);
  });

  it('labels each shape with a kind that produces it (the ellipse covers the remaining symbols)', () => {
    for (const entry of shapeLegend()) {
      if (entry.kind === null) {
        expect(entry.shape).toBe('ellipse');
        continue;
      }
      expect(graphStyle(node({ kind: entry.kind })).shape).toBe(entry.shape);
    }
  });
});

describe('zoomedLabelSize (S-44 T-510)', () => {
  it('is null at or above the label threshold', () => {
    expect(zoomedLabelSize(1)).toBeNull();
    expect(zoomedLabelSize(LABEL_ZOOM_THRESHOLD)).toBeNull();
  });

  it('grows as the zoom shrinks so the label keeps a readable on-screen size, capped', () => {
    expect(zoomedLabelSize(0.5)).toBe(24);
    expect(zoomedLabelSize(0.25)).toBe(48);
    for (const zoom of [0.7, 0.5, 0.3, 0.2]) expect((zoomedLabelSize(zoom) ?? 0) * zoom).toBeGreaterThanOrEqual(11.5);
    expect(zoomedLabelSize(0.1)).toBe(zoomedLabelSize(0.05));
    expect(zoomedLabelSize(0.05)).toBeLessThanOrEqual(60);
  });
});

describe('edge width and opacity (S-44 T-510)', () => {
  it('log-scales width and opacity by weight, clamped', () => {
    expect(edgeWidth(10)).toBeGreaterThan(edgeWidth(1));
    expect(edgeWidth(1000)).toBeGreaterThan(edgeWidth(10));
    expect(edgeWidth(1e9)).toBe(edgeWidth(1e12));
    expect(edgeOpacity(10)).toBeGreaterThan(edgeOpacity(1));
    expect(edgeOpacity(1e9)).toBeLessThanOrEqual(1);
    expect(edgeWidth(0)).toBe(edgeWidth(1));
  });
});

describe('resolveStyleVars (S-44 T-510)', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--dv-acc');
    refreshTheme();
  });

  it('reads the CSS variables into concrete strings, cached until refreshTheme()', () => {
    document.documentElement.style.setProperty('--dv-acc', 'rgb(1, 2, 3)');
    const first = resolveStyleVars(document.documentElement);
    expect(first.color('--dv-acc')).toBe('rgb(1, 2, 3)');

    document.documentElement.style.setProperty('--dv-acc', 'rgb(4, 5, 6)');
    expect(resolveStyleVars(document.documentElement).color('--dv-acc')).toBe('rgb(1, 2, 3)');

    refreshTheme();
    expect(resolveStyleVars(document.documentElement).color('--dv-acc')).toBe('rgb(4, 5, 6)');
  });

  it('falls back to a non-empty colour for an undefined variable', () => {
    refreshTheme();
    const vars = resolveStyleVars(document.documentElement);
    expect(vars.color('--dv-nope')).not.toBe('');
  });

  describe('with a canvas to convert colours', () => {
    afterEach(() => vi.unstubAllGlobals());

    /** A 2D context that, like a browser, ignores a fillStyle it cannot parse. */
    class FakeOffscreenCanvas {
      getContext() {
        const parse = (v: string): [number, number, number, number] | null => {
          if (v === 'black') return [0, 0, 0, 255];
          if (v === 'white') return [255, 255, 255, 255];
          if (v === 'transparent') return [0, 0, 0, 0];
          if (v === 'oklch(0.6 0.1 200)') return [10, 20, 30, 255];
          const m = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(v);
          return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Math.round(Number(m[4] ?? 1) * 255)] : null;
        };
        let style: [number, number, number, number] = [0, 0, 0, 255];
        let painted: [number, number, number, number] = [0, 0, 0, 0];
        return {
          get fillStyle(): string {
            return `rgba(${style.join(', ')})`;
          },
          set fillStyle(v: string) {
            style = parse(v) ?? style;
          },
          clearRect: () => {
            painted = [0, 0, 0, 0];
          },
          fillRect: () => {
            if (style[3] > 0) painted = style;
          },
          getImageData: () => ({ data: painted }),
        };
      }
    }

    function resolve(raw: string): string {
      vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
      document.documentElement.style.setProperty('--dv-acc', raw);
      refreshTheme();
      return resolveStyleVars(document.documentElement).color('--dv-acc');
    }

    it('converts a modern colour to rgba', () => {
      expect(resolve('oklch(0.6 0.1 200)')).toBe('rgba(10, 20, 30, 1)');
    });

    it('falls back to the neutral fallback for a value the canvas cannot parse, never the raw string', () => {
      const out = resolve('oklch(from nonsense)');
      expect(out).not.toContain('oklch');
      expect(out).toBe(resolve(''));
    });

    it('keeps an explicitly transparent token transparent', () => {
      expect(resolve('transparent')).toBe('rgba(0, 0, 0, 0)');
    });
  });
});
