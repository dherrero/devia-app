import type { GraphOverviewNode, GraphViewEdge } from '../../../../../shared/domain/code-graph';

/** A `--dv-*` CSS custom property name; resolved to a concrete colour only at render time. */
export type ColorVar = `--dv-${string}`;

export type NodeShape =
  | 'round-rectangle' | 'rectangle' | 'ellipse' | 'round-hexagon' | 'round-octagon'
  | 'round-diamond' | 'barrel' | 'round-tag';

export interface NodeStateFlags {
  selected?: boolean;
  hovered?: boolean;
  expanded?: boolean;
}

export interface NodeVisual {
  color: ColorVar;
  /** Index into COMMUNITY_PALETTE, or null for the neutral colour. */
  paletteIndex: number | null;
  shape: NodeShape;
  size: number;
  ring: boolean;
  borderColor: ColorVar | null;
  borderWidth: number;
  borderStyle: 'solid' | 'dashed';
  opacity: number;
}

export interface EdgeVisual {
  color: ColorVar;
  width: number;
  opacity: number;
  curve: 'haystack';
}

/**
 * The technology badge hues: mid lightness, tuned to read on the surfaces of
 * every theme, ordered so neighbouring community numbers get distant hues.
 */
export const COMMUNITY_PALETTE: readonly ColorVar[] = [
  '--dv-tech-ts', '--dv-tech-node', '--dv-tech-rust', '--dv-tech-php',
  '--dv-tech-go', '--dv-tech-ruby', '--dv-tech-gradle', '--dv-tech-elixir',
  '--dv-tech-maven', '--dv-tech-dotnet', '--dv-tech-python', '--dv-tech-git',
];

export const NEUTRAL_COLOR: ColorVar = '--dv-dim';
export const HUB_RING_COLOR: ColorVar = '--dv-warn';
export const SELECTED_COLOR: ColorVar = '--dv-acc';
export const HOVER_COLOR: ColorVar = '--dv-acc-bor';
export const EXPANDED_COLOR: ColorVar = '--dv-bor-2';
export const EDGE_COLOR: ColorVar = '--dv-bor-2';
export const LABEL_COLOR: ColorVar = '--dv-fg';
export const LABEL_OUTLINE_COLOR: ColorVar = '--dv-bg';
export const MORE_FILL_COLOR: ColorVar = '--dv-surf-3';

/** Every variable the renderer needs resolved, besides the palette. */
export const STYLE_VARS: readonly ColorVar[] = [
  NEUTRAL_COLOR, HUB_RING_COLOR, SELECTED_COLOR, HOVER_COLOR, EXPANDED_COLOR,
  EDGE_COLOR, LABEL_COLOR, LABEL_OUTLINE_COLOR, MORE_FILL_COLOR,
];

export const HUB_SCALE = 1.35;
export const HUB_RING_WIDTH = 3;
export const HOVER_BORDER_WIDTH = 2;
export const SELECTED_BORDER_WIDTH = 4;
export const EXPANDED_BORDER_WIDTH = 2;
export const TEST_OPACITY = 0.45;
export const FADED_EDGE_FACTOR = 0.2;
export const ADJACENT_EDGE_OPACITY = 0.9;

interface SizeRange {
  min: number;
  max: number;
}

const SIZE: Record<'dir' | 'file' | 'type' | 'callable' | 'other', SizeRange> = {
  dir: { min: 30, max: 72 },
  file: { min: 18, max: 44 },
  type: { min: 14, max: 30 },
  callable: { min: 8, max: 18 },
  other: { min: 8, max: 16 },
};

/** Pixels added per doubling of the child count. */
const SIZE_PER_DOUBLING = 4;

const SHAPES: Partial<Record<GraphOverviewNode['kind'], NodeShape>> = {
  dir: 'round-rectangle',
  file: 'rectangle',
  class: 'ellipse',
  interface: 'round-hexagon',
  enum: 'round-octagon',
  component: 'round-diamond',
  module: 'barrel',
  namespace: 'barrel',
  route: 'round-tag',
};

function sizeRange(kind: GraphOverviewNode['kind']): SizeRange {
  switch (kind) {
    case 'dir': return SIZE.dir;
    case 'file': return SIZE.file;
    case 'class': case 'interface': case 'enum': case 'component': case 'module': case 'namespace':
      return SIZE.type;
    case 'function': case 'method': return SIZE.callable;
    default: return SIZE.other;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function paletteIndexOf(community: number | undefined): number | null {
  if (community === undefined || !Number.isInteger(community) || community < 0) return null;
  return community % COMMUNITY_PALETTE.length;
}

export function graphStyle(node: GraphOverviewNode, state: NodeStateFlags = {}): NodeVisual {
  const paletteIndex = paletteIndexOf(node.community);
  const color = paletteIndex === null ? NEUTRAL_COLOR : (COMMUNITY_PALETTE[paletteIndex] ?? NEUTRAL_COLOR);
  const range = sizeRange(node.kind);
  const count = Math.max(0, node.symbolCount ?? node.childCount);
  const base = clamp(range.min + SIZE_PER_DOUBLING * Math.log2(1 + count), range.min, range.max);
  const ring = node.hub === true;
  const size = Math.round(ring ? base * HUB_SCALE : base);

  let borderColor: ColorVar | null = ring ? HUB_RING_COLOR : null;
  let borderWidth = ring ? HUB_RING_WIDTH : 0;
  let borderStyle: NodeVisual['borderStyle'] = 'solid';
  if (state.expanded) {
    borderStyle = 'dashed';
    if (!ring) {
      borderColor = EXPANDED_COLOR;
      borderWidth = EXPANDED_BORDER_WIDTH;
    }
  }
  if (state.hovered && !state.selected) {
    borderColor = HOVER_COLOR;
    borderWidth = Math.max(borderWidth, HOVER_BORDER_WIDTH);
  }
  if (state.selected) {
    borderColor = SELECTED_COLOR;
    borderWidth = SELECTED_BORDER_WIDTH;
  }

  return {
    color,
    paletteIndex,
    shape: SHAPES[node.kind] ?? 'ellipse',
    size,
    ring,
    borderColor,
    borderWidth,
    borderStyle,
    opacity: node.isTest && !state.selected ? TEST_OPACITY : 1,
  };
}

export function edgeWidth(weight: number): number {
  const w = Math.max(1, weight);
  return Math.round(clamp(1 + 0.6 * Math.log2(w), 1, 6) * 10) / 10;
}

export function edgeOpacity(weight: number): number {
  const w = Math.max(1, weight);
  return Math.round(clamp(0.3 + 0.06 * Math.log2(w), 0.3, 0.75) * 100) / 100;
}

export function edgeStyle(edge: GraphViewEdge, ctx: { selectedId?: string | null } = {}): EdgeVisual {
  const selectedId = ctx.selectedId ?? null;
  const width = edgeWidth(edge.weight);
  const opacity = edgeOpacity(edge.weight);
  if (selectedId === null) return { color: EDGE_COLOR, width, opacity, curve: 'haystack' };
  if (edge.source === selectedId || edge.target === selectedId) {
    return { color: SELECTED_COLOR, width, opacity: Math.max(opacity, ADJACENT_EDGE_OPACITY), curve: 'haystack' };
  }
  return { color: EDGE_COLOR, width, opacity: Math.round(opacity * FADED_EDGE_FACTOR * 100) / 100, curve: 'haystack' };
}

export interface ResolvedStyleVars {
  /** The concrete colour of a `--dv-*` variable, as a string the canvas renderer understands. */
  color(name: ColorVar): string;
}

const FALLBACK_COLOR = 'gray';

let cache = new WeakMap<Element, Map<string, string>>();

/** Forgets every resolved colour: call after a theme switch. */
export function refreshTheme(): void {
  cache = new WeakMap();
}

/**
 * Cytoscape does not parse `oklch()`/`color-mix()` (the tokens' syntax), so each
 * colour is painted on a 1px canvas and read back as rgba. Without
 * OffscreenCanvas (jsdom) the raw value is returned untouched.
 */
function toCanvasColor(raw: string): string {
  if (typeof OffscreenCanvas === 'undefined') return raw;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  if (!ctx) return raw;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = 'rgba(0, 0, 0, 0)';
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
  if (a === 0) return raw;
  return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
}

export function resolveStyleVars(el: Element): ResolvedStyleVars {
  let resolved = cache.get(el);
  if (!resolved) {
    resolved = new Map();
    cache.set(el, resolved);
  }
  const map = resolved;
  let computed: CSSStyleDeclaration | null = null;
  return {
    color(name: ColorVar): string {
      const hit = map.get(name);
      if (hit !== undefined) return hit;
      computed ??= getComputedStyle(el);
      const raw = computed.getPropertyValue(name).trim();
      const value = raw === '' ? FALLBACK_COLOR : toCanvasColor(raw);
      map.set(name, value);
      return value;
    },
  };
}
