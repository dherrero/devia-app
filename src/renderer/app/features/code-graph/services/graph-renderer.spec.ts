import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GraphOverviewNode, GraphViewEdge } from '../../../../../shared/domain/code-graph';
import { FakeGraphRenderer } from '../testing/fake-graph-renderer';
import type { RunningLayout } from '../utils/graph-layout';
import { COMMUNITY_PALETTE, zoomedLabelSize, type ColorVar, type ResolvedStyleVars } from '../utils/graph-style';
import {
  CytoscapeGraphRenderer, GRAPH_RENDERER_FACTORY, LABEL_ZOOM_THRESHOLD, buildStylesheet, createCytoscapeRenderer,
  type GraphRenderer, type ZoneLike,
} from './graph-renderer';
import { edgeId, moreNodeId, type MoreNode, type ViewNode } from './graph-view.store';

const ZONE: ZoneLike = { run: (fn) => fn(), runOutsideAngular: (fn) => fn() };
const OPTIONS = { reducedMotion: true, moreLabel: (n: number) => `+${n}` };

function n(id: string, over: Partial<GraphOverviewNode> = {}): GraphOverviewNode {
  return { id, kind: 'dir', label: id, childCount: 2, path: id, ...over };
}

function e(source: string, target: string, weight = 1): GraphViewEdge {
  return { source, target, kind: 'aggregate', weight };
}

const frame = () => new Promise<void>((resolve) => setTimeout(resolve, 40));

describe('GraphRenderer contract via FakeGraphRenderer (S-44 T-510)', () => {
  it('delivers events to subscribers until they unsubscribe', () => {
    const r: GraphRenderer & FakeGraphRenderer = new FakeGraphRenderer();
    const onSelect = vi.fn();
    const onExpand = vi.fn();
    const onMore = vi.fn();
    const onViewport = vi.fn();
    const offs = [r.onSelect(onSelect), r.onExpandRequest(onExpand), r.onShowMore(onMore), r.onViewportChange(onViewport)];

    r.emitSelect('a');
    r.emitExpandRequest('a');
    r.emitShowMore('a', 500);
    r.emitViewport({ zoom: 1, pan: { x: 0, y: 0 }, labels: true });
    for (const off of offs) off();
    r.emitSelect('b');
    r.emitExpandRequest('b');
    r.emitShowMore(null, 0);
    r.emitViewport({ zoom: 2, pan: { x: 0, y: 0 }, labels: true });

    expect(onSelect.mock.calls).toEqual([['a']]);
    expect(onExpand.mock.calls).toEqual([['a']]);
    expect(onMore.mock.calls).toEqual([['a', 500]]);
    expect(onViewport).toHaveBeenCalledTimes(1);
  });

  it('records the calls a component makes, and destroy() drops the listeners', async () => {
    const r = new FakeGraphRenderer();
    const el = document.createElement('div');
    const onSelect = vi.fn();
    r.onSelect(onSelect);
    r.mount(el);
    await r.setElements([n('a')], []);
    await r.explode('a', [n('a1')], []);
    r.collapse('a', ['a1'], []);
    r.destroy();
    r.emitSelect('a');
    expect(r.calls.map((c) => c[0])).toEqual(['mount', 'setElements', 'explode', 'collapse', 'destroy']);
    expect(r.mounted).toBe(el);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('buildStylesheet (S-44 T-510)', () => {
  const vars: ResolvedStyleVars = { color: (name: ColorVar) => `rgb(${name.length}, 0, 0)` };

  it('resolves every colour through the theme variables (no hex literals)', () => {
    const json = JSON.stringify(buildStylesheet(vars));
    expect(json).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(json).toContain('rgb(');
  });

  it('has a class per palette entry, label hiding for the zoomed-out view except hubs and the selection, and cheap edges', () => {
    const sheet = buildStylesheet(vars);
    const selectors = sheet.map((b) => b.selector);
    for (let i = 0; i < COMMUNITY_PALETTE.length; i++) expect(selectors).toContain(`node.c${i}`);
    expect(selectors).toContain('node.zo');
    expect(selectors.some((s) => s.includes('node.zo.hub') && s.includes('node.zo.sel'))).toBe(true);
    const edge = sheet.find((b) => b.selector === 'edge');
    expect(JSON.stringify(edge)).toContain('haystack');
    const node = sheet.find((b) => b.selector === 'node');
    expect(JSON.stringify(node)).toContain('min-zoomed-font-size');
  });
});

describe('GRAPH_RENDERER_FACTORY (S-44 T-510)', () => {
  it('creates a Cytoscape renderer by default', async () => {
    const factory = TestBed.inject(GRAPH_RENDERER_FACTORY);
    const renderer = await factory(OPTIONS);
    expect(renderer).toBeInstanceOf(CytoscapeGraphRenderer);
    renderer.destroy();
  });
});

describe('CytoscapeGraphRenderer headless smoke (S-44 T-510)', () => {
  let renderer: CytoscapeGraphRenderer | null = null;

  afterEach(() => {
    renderer?.destroy();
    renderer = null;
  });

  async function mounted(nodes: ViewNode[], edges: GraphViewEdge[]): Promise<CytoscapeGraphRenderer> {
    const r = await createCytoscapeRenderer(ZONE, OPTIONS, { headless: true });
    renderer = r;
    r.mount(document.createElement('div'));
    await r.setElements(nodes, edges);
    return r;
  }

  function core(r: CytoscapeGraphRenderer) {
    const cy = r.core;
    if (!cy) throw new Error('not mounted');
    return cy;
  }

  it('renders the nodes and edges it is given', async () => {
    const r = await mounted([n('A', { community: 1, hub: true }), n('B'), n('C', { isTest: true, kind: 'file' })], [e('A', 'B', 3), e('B', 'C')]);
    const cy = core(r);
    expect(cy.nodes().map((x) => x.id()).sort()).toEqual(['A', 'B', 'C']);
    expect(cy.edges()).toHaveLength(2);
    expect(cy.getElementById('A').hasClass('c1')).toBe(true);
    expect(cy.getElementById('A').hasClass('hub')).toBe(true);
    expect(cy.getElementById('B').hasClass('cn')).toBe(true);
    expect(cy.getElementById('C').hasClass('test')).toBe(true);
    expect(cy.getElementById(edgeId(e('A', 'B', 3))).data('width')).toBeGreaterThan(cy.getElementById(edgeId(e('B', 'C'))).data('width'));
  });

  it('explodes a node into its children near it and collapses back', async () => {
    const r = await mounted([n('A'), n('B')], [e('A', 'B', 3)]);
    const cy = core(r);
    cy.getElementById('A').position({ x: 500, y: 500 });

    await r.explode('A', [n('a1', { kind: 'file', parentId: 'A' }), n('a2', { kind: 'file', parentId: 'A' })], [e('a1', 'B', 2), e('a2', 'B'), e('a1', 'ghost')]);
    expect(cy.getElementById('A').empty()).toBe(true);
    expect(cy.nodes().map((x) => x.id()).sort()).toEqual(['B', 'a1', 'a2']);
    expect(cy.edges()).toHaveLength(2);
    const p = cy.getElementById('a1').position();
    expect(Math.hypot(p.x - 500, p.y - 500)).toBeLessThan(400);

    r.collapse('A', ['a1', 'a2'], [e('A', 'B', 3)]);
    expect(cy.nodes().map((x) => x.id()).sort()).toEqual(['A', 'B']);
    expect(cy.edges().map((x) => x.id())).toEqual([edgeId(e('A', 'B', 3))]);
  });

  it('spreads the children without overlap, moves the neighbours out of the way and back on collapse', async () => {
    const r = await mounted([n('A', { childCount: 8 }), n('B')], []);
    const cy = core(r);
    cy.getElementById('A').position({ x: 0, y: 0 });
    cy.getElementById('B').position({ x: 120, y: 0 });
    const kids = Array.from({ length: 8 }, (_, i) => n(`a${i}`, { kind: 'file', parentId: 'A' }));

    await r.explode('A', kids, []);
    const placed = kids.map((k) => cy.getElementById(k.id));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]?.position();
        const b = placed[j]?.position();
        const room = (Number(placed[i]?.data('size')) + Number(placed[j]?.data('size'))) / 2;
        if (a && b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(room);
      }
    }
    const far = Math.max(...placed.map((k) => Math.hypot(k.position().x, k.position().y)));
    const b = cy.getElementById('B').position();
    expect(b.x).toBeGreaterThan(far + Number(cy.getElementById('B').data('size')) / 2);
    expect(b.y).toBeCloseTo(0);

    r.collapse('A', kids.map((k) => k.id), []);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(cy.getElementById('A').position()).toEqual({ x: 0, y: 0 });
    expect(cy.getElementById('B').position().x).toBeCloseTo(120);
  });

  type Layouts = { run: (eles: { map: (fn: (x: { id(): string }) => string) => string[] }, options: { name: string }) => RunningLayout };

  function spyLayouts(r: CytoscapeGraphRenderer) {
    return vi.spyOn(r as unknown as Layouts, 'run');
  }

  it('keeps the positions of the surviving nodes and the viewport when it reloads', async () => {
    const r = await mounted([n('A'), n('B'), n('C')], [e('A', 'B')]);
    const cy = core(r);
    cy.getElementById('A').position({ x: 10, y: 20 });
    cy.getElementById('B').position({ x: 300, y: 40 });
    cy.getElementById('C').position({ x: -200, y: 90 });
    cy.viewport({ zoom: 0.8, pan: { x: 5, y: 7 } });
    const layouts = spyLayouts(r);

    await r.setElements([n('A', { childCount: 9 }), n('B'), n('C'), n('D')], [e('A', 'B', 4), e('C', 'D')], { preserve: true });

    expect(cy.getElementById('A').position()).toEqual({ x: 10, y: 20 });
    expect(cy.getElementById('B').position()).toEqual({ x: 300, y: 40 });
    expect(cy.getElementById('C').position()).toEqual({ x: -200, y: 90 });
    expect(cy.getElementById('D').nonempty()).toBe(true);
    expect(cy.zoom()).toBe(0.8);
    expect(cy.pan()).toEqual({ x: 5, y: 7 });
    expect(cy.edges()).toHaveLength(2);
    expect(layouts.mock.calls.some(([, options]) => options.name === 'fcose')).toBe(false);
  });

  it('places a new node of an expanded parent next to its siblings without covering them', async () => {
    const r = await mounted([n('A', { childCount: 3 }), n('B')], []);
    const cy = core(r);
    cy.getElementById('A').position({ x: 0, y: 0 });
    cy.getElementById('B').position({ x: 2000, y: 0 });
    const kids = [n('a1', { kind: 'file', parentId: 'A' }), n('a2', { kind: 'file', parentId: 'A' })];
    await r.explode('A', kids, []);

    await r.setElements([...kids, n('a3', { kind: 'file', parentId: 'A' }), n('B')], [], { preserve: true });

    const p3 = cy.getElementById('a3').position();
    expect(Math.hypot(p3.x, p3.y)).toBeLessThan(200);
    for (const id of ['a1', 'a2']) {
      const p = cy.getElementById(id).position();
      const room = (Number(cy.getElementById(id).data('size')) + Number(cy.getElementById('a3').data('size'))) / 2;
      expect(Math.hypot(p.x - p3.x, p.y - p3.y)).toBeGreaterThan(room);
    }
  });

  it('runs a fresh global layout on reload when fewer than ~30% of the nodes survive', async () => {
    const r = await mounted([n('A'), n('B'), n('C')], []);
    const layouts = spyLayouts(r);
    await r.setElements([n('A'), n('X'), n('Y'), n('Z'), n('W')], [], { preserve: true });
    expect(layouts.mock.calls.some(([, options]) => options.name === 'fcose')).toBe(true);
  });

  it('animates only the nodes an explosion really moves (more than half a pixel)', async () => {
    const r = await mounted([n('A', { childCount: 2 }), n('B'), n('F')], []);
    const cy = core(r);
    cy.getElementById('A').position({ x: 0, y: 0 });
    cy.getElementById('B').position({ x: 120, y: 0 });
    cy.getElementById('F').position({ x: 100000, y: 0 });
    const layouts = spyLayouts(r);

    await r.explode('A', [n('a1', { kind: 'file', parentId: 'A' }), n('a2', { kind: 'file', parentId: 'A' })], []);
    const moved = layouts.mock.calls.map(([eles]) => eles.map((x) => x.id()).sort());
    expect(moved).toEqual([['B', 'a1', 'a2']]);

    layouts.mockClear();
    r.collapse('A', ['a1', 'a2'], []);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(layouts.mock.calls.map(([eles]) => eles.map((x) => x.id()).sort())).toEqual([['B']]);
  });

  it('keeps the selected and hub labels readable when zoomed out (zoom-compensated font)', async () => {
    const r = await mounted([n('A'), n('B', { hub: true }), n('C')], []);
    const cy = core(r);
    r.select('A');
    cy.zoom(0.25);
    await frame();
    const expected = zoomedLabelSize(0.25);
    expect(expected).not.toBeNull();
    expect(parseFloat(String(cy.getElementById('A').style('font-size')))).toBe(expected);
    expect(parseFloat(String(cy.getElementById('B').style('font-size')))).toBe(expected);
    expect(cy.getElementById('C').style('label')).toBe('');

    r.select('C');
    expect(parseFloat(String(cy.getElementById('C').style('font-size')))).toBe(expected);

    cy.zoom(0.1);
    await frame();
    expect(parseFloat(String(cy.getElementById('C').style('font-size')))).toBe(zoomedLabelSize(0.1));

    cy.zoom(1);
    await frame();
    expect(parseFloat(String(cy.getElementById('C').style('font-size')))).toBe(10);
  });

  it('adds a "more" page and removes nodes', async () => {
    const more: MoreNode = { id: moreNodeId('A', 2), kind: 'more', parentId: 'A', offset: 2, remaining: 3 };
    const r = await mounted([n('a1', { parentId: 'A' }), more], []);
    const cy = core(r);
    expect(cy.getElementById(more.id).data('label')).toBe('+3');
    r.removeNode(more.id);
    await r.addNodes('A', [n('a3', { parentId: 'A' })], [e('a3', 'a1')]);
    expect(cy.nodes().map((x) => x.id()).sort()).toEqual(['a1', 'a3']);
    expect(cy.edges()).toHaveLength(1);
  });

  it('turns taps into select / show-more / expand events, and stops after unsubscribing', async () => {
    const more: MoreNode = { id: moreNodeId('A', 2), kind: 'more', parentId: 'A', offset: 2, remaining: 3 };
    const r = await mounted([n('a1'), more], []);
    const cy = core(r);
    const onSelect = vi.fn();
    const onMore = vi.fn();
    const onExpand = vi.fn();
    const off = r.onSelect(onSelect);
    r.onShowMore(onMore);
    r.onExpandRequest(onExpand);

    cy.getElementById('a1').emit('tap');
    cy.emit('tap');
    cy.getElementById(more.id).emit('tap');
    cy.getElementById('a1').emit('dbltap');
    off();
    cy.getElementById('a1').emit('tap');

    expect(onSelect.mock.calls).toEqual([['a1'], [null]]);
    expect(onMore.mock.calls).toEqual([['A', 2]]);
    expect(onExpand.mock.calls).toEqual([['a1']]);
  });

  it('highlights the selection and its edges, fading the rest', async () => {
    const r = await mounted([n('A'), n('B'), n('C')], [e('A', 'B'), e('B', 'C')]);
    const cy = core(r);
    r.select('A');
    expect(cy.getElementById('A').hasClass('sel')).toBe(true);
    expect(cy.getElementById(edgeId(e('A', 'B'))).hasClass('adj')).toBe(true);
    expect(cy.getElementById(edgeId(e('B', 'C'))).hasClass('faded')).toBe(true);
    r.select(null);
    expect(cy.getElementById('A').hasClass('sel')).toBe(false);
    expect(cy.edges('.faded')).toHaveLength(0);
  });

  it('hides filtered elements', async () => {
    const r = await mounted([n('A'), n('t', { kind: 'file', isTest: true })], [e('A', 't')]);
    const cy = core(r);
    r.setFilters({ hideTests: true });
    expect(cy.getElementById('t').hasClass('filtered')).toBe(true);
    r.setFilters({ hiddenKinds: new Set(['dir']), minEdgeWeight: 2 });
    expect(cy.getElementById('t').hasClass('filtered')).toBe(false);
    expect(cy.getElementById('A').hasClass('filtered')).toBe(true);
    expect(cy.getElementById(edgeId(e('A', 't'))).hasClass('filtered')).toBe(true);
  });

  it('hides generated nodes and edges of hidden kinds, also on elements added later (T-511)', async () => {
    const calls: GraphViewEdge = { source: 'A', target: 'B', kind: 'calls', weight: 1 };
    const r = await mounted([n('A'), n('B'), n('g', { kind: 'file', generated: true })], [calls, e('A', 'g')]);
    const cy = core(r);
    r.setFilters({ hideGenerated: true, hiddenEdgeKinds: new Set(['calls']) });
    expect(cy.getElementById('g').hasClass('filtered')).toBe(true);
    expect(cy.getElementById(edgeId(calls)).hasClass('filtered')).toBe(true);
    expect(cy.getElementById(edgeId(e('A', 'g'))).hasClass('filtered')).toBe(false);
    await r.explode('B', [n('b1', { generated: true, parentId: 'B' }), n('b2', { parentId: 'B' })], [{ source: 'b2', target: 'A', kind: 'calls', weight: 1 }]);
    expect(cy.getElementById('b1').hasClass('filtered')).toBe(true);
    expect(cy.getElementById('b2').hasClass('filtered')).toBe(false);
    expect(cy.getElementById(edgeId({ source: 'b2', target: 'A', kind: 'calls', weight: 1 })).hasClass('filtered')).toBe(true);
    r.setFilters({});
    expect(cy.$('.filtered')).toHaveLength(0);
  });

  it('hides labels below the zoom threshold (throttled) and reports the viewport', async () => {
    const r = await mounted([n('A'), n('B')], []);
    const cy = core(r);
    const onViewport = vi.fn();
    r.onViewportChange(onViewport);
    cy.zoom(LABEL_ZOOM_THRESHOLD / 4);
    cy.zoom(LABEL_ZOOM_THRESHOLD / 3);
    await frame();
    expect(cy.getElementById('A').hasClass('zo')).toBe(true);
    expect(onViewport).toHaveBeenCalledTimes(1);
    expect(onViewport.mock.calls[0]?.[0]).toMatchObject({ labels: false });

    cy.zoom(LABEL_ZOOM_THRESHOLD * 2);
    await frame();
    expect(cy.getElementById('A').hasClass('zo')).toBe(false);
  });

  it('mounts without any Cytoscape console warning (no custom wheel sensitivity)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await mounted([n('A')], []);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('pans by a screen offset', async () => {
    const r = await mounted([n('A'), n('B')], []);
    const cy = core(r);
    const before = { ...cy.pan() };
    r.panBy(80, -40);
    expect(cy.pan()).toEqual({ x: before.x + 80, y: before.y - 40 });
  });

  it('destroy() releases the instance and later calls are harmless', async () => {
    const r = await mounted([n('A')], []);
    const cy = core(r);
    r.destroy();
    expect(cy.destroyed()).toBe(true);
    expect(r.core).toBeNull();
    expect(() => {
      r.select('A');
      r.fit();
      r.zoomBy(2);
      r.panBy(10, 10);
      r.resize();
      r.refreshTheme();
      r.collapse('A', [], []);
    }).not.toThrow();
    await expect(r.explode('A', [n('a1')], [])).resolves.toBeUndefined();
  });
});
