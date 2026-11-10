import { afterEach, describe, expect, it } from 'vitest';

import type { GraphOverviewNode, GraphViewEdge } from '../../../../../shared/domain/code-graph';
import {
  COMMUNITY_PALETTE, NEUTRAL_COLOR, STYLE_VARS, edgeStyle, graphStyle, refreshTheme, resolveStyleVars,
} from './graph-style';

function node(over: Partial<GraphOverviewNode> = {}): GraphOverviewNode {
  return { id: 'n', kind: 'file', label: 'n.ts', childCount: 0, path: 'src/n.ts', ...over };
}

function edge(over: Partial<GraphViewEdge> = {}): GraphViewEdge {
  return { source: 'a', target: 'b', kind: 'aggregate', weight: 1, ...over };
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
    const samples = [
      graphStyle(node({ community: 0, hub: true })),
      graphStyle(node({ kind: 'dir' })),
      graphStyle(node(), { selected: true, hovered: true, expanded: true }),
    ];
    for (const s of samples) {
      expect(s.color).toMatch(/^--dv-[a-z0-9-]+$/);
      if (s.borderColor !== null) expect(s.borderColor).toMatch(/^--dv-[a-z0-9-]+$/);
      expect(JSON.stringify(s)).not.toMatch(HEX);
    }
    const e = edgeStyle(edge({ weight: 40 }), { selectedId: 'a' });
    expect(e.color).toMatch(/^--dv-[a-z0-9-]+$/);
    for (const v of [...STYLE_VARS, ...COMMUNITY_PALETTE, NEUTRAL_COLOR]) expect(v).toMatch(/^--dv-[a-z0-9-]+$/);
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
    expect(hub.borderWidth).toBeGreaterThan(0);
    expect(hub.borderColor).not.toBeNull();
  });

  it('dims test files', () => {
    expect(graphStyle(node({ isTest: true })).opacity).toBeLessThan(graphStyle(node()).opacity);
    expect(graphStyle(node()).opacity).toBe(1);
  });

  it('applies selected, hover and expanded modifiers, selection winning', () => {
    const base = graphStyle(node());
    const hovered = graphStyle(node(), { hovered: true });
    const selected = graphStyle(node(), { selected: true, hovered: true });
    const expanded = graphStyle(node(), { expanded: true });
    expect(base.borderWidth).toBe(0);
    expect(hovered.borderWidth).toBeGreaterThan(0);
    expect(selected.borderWidth).toBeGreaterThan(hovered.borderWidth);
    expect(selected.borderColor).toBe('--dv-acc');
    expect(expanded.borderStyle).toBe('dashed');
    expect(graphStyle(node({ isTest: true }), { selected: true }).opacity).toBe(1);
  });
});

describe('edgeStyle (S-44 T-510)', () => {
  it('log-scales width and opacity by weight, clamped', () => {
    const w1 = edgeStyle(edge({ weight: 1 }));
    const w10 = edgeStyle(edge({ weight: 10 }));
    const w1000 = edgeStyle(edge({ weight: 1000 }));
    const wHuge = edgeStyle(edge({ weight: 1e9 }));
    expect(w10.width).toBeGreaterThan(w1.width);
    expect(w1000.width).toBeGreaterThan(w10.width);
    expect(wHuge.width).toBe(edgeStyle(edge({ weight: 1e12 })).width);
    expect(w10.opacity).toBeGreaterThan(w1.opacity);
    expect(wHuge.opacity).toBeLessThanOrEqual(1);
    expect(edgeStyle(edge({ weight: 0 })).width).toBe(w1.width);
  });

  it('uses a straight, cheap curve (no bezier) for every edge', () => {
    expect(edgeStyle(edge()).curve).toBe('haystack');
    expect(edgeStyle(edge({ kind: 'calls' })).curve).not.toBe('bezier');
  });

  it('dims edges not adjacent to the selected node and highlights adjacent ones', () => {
    const none = edgeStyle(edge({ weight: 5 }));
    const adjacent = edgeStyle(edge({ weight: 5 }), { selectedId: 'b' });
    const other = edgeStyle(edge({ weight: 5 }), { selectedId: 'z' });
    expect(adjacent.opacity).toBeGreaterThanOrEqual(none.opacity);
    expect(adjacent.color).toBe('--dv-acc');
    expect(other.opacity).toBeLessThan(none.opacity);
    expect(none.color).not.toBe('--dv-acc');
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
});
