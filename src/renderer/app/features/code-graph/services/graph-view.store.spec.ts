import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GraphExpandOptions, GraphOverviewNode, GraphOverviewOptions, GraphViewEdge, GraphViewPage,
} from '../../../../../shared/domain/code-graph';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import {
  GraphViewStore, VISIBLE_IDS_LIMIT, VISIBLE_NODE_CAP, edgeId, moreNodeId, type GraphViewChange,
} from './graph-view.store';

const P = '/ws/proj';

function n(id: string, over: Partial<GraphOverviewNode> = {}): GraphOverviewNode {
  return { id, kind: 'dir', label: id, childCount: 2, path: id, ...over };
}

function e(source: string, target: string, weight = 1, kind: GraphViewEdge['kind'] = 'aggregate'): GraphViewEdge {
  return { source, target, kind, weight };
}

function page(nodes: GraphOverviewNode[], edges: GraphViewEdge[] = [], over: Partial<GraphViewPage> = {}): GraphViewPage {
  return { nodes, edges, total: nodes.length, hasMore: false, ...over };
}

const EMPTY = page([]);

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A small consistent graph: dirs A, B, C. Edge weights add up across levels the
 * way the server aggregates them (A→B 3 = a1→B 2 + a2→B 1), and expand maps the
 * new children's edges onto whatever is in `visibleIds`, like the real query.
 */
function smallGraph() {
  const overview = () => page([n('dir:A', { community: 0 }), n('dir:B', { community: 1 }), n('dir:C', { childCount: 0 })], [
    e('dir:A', 'dir:B', 3),
    e('dir:B', 'dir:C', 1),
  ]);
  const expand = (id: string, opts: GraphExpandOptions | undefined): GraphViewPage => {
    const visible = new Set(opts?.visibleIds ?? []);
    switch (id) {
      case 'dir:A':
        return page(
          [n('a1', { kind: 'file', parentId: 'dir:A', childCount: 1 }), n('a2', { kind: 'file', parentId: 'dir:A', childCount: 0 })],
          visible.has('dir:B')
            ? [e('a1', 'dir:B', 2), e('a2', 'dir:B', 1), e('a1', 'a2', 1, 'imports')]
            : [e('a1', 'b1', 2), e('a2', 'b2', 1), e('a1', 'a2', 1, 'imports')],
        );
      case 'dir:B':
        return page(
          [n('b1', { kind: 'file', parentId: 'dir:B', childCount: 0 }), n('b2', { kind: 'file', parentId: 'dir:B', childCount: 0 })],
          visible.has('a1')
            ? [e('a1', 'b1', 2), e('a2', 'b2', 1), e('b1', 'dir:C', 1)]
            : [e('dir:A', 'b1', 2), e('dir:A', 'b2', 1), e('b1', 'dir:C', 1)],
        );
      case 'a1':
        return page([n('s1', { kind: 'function', parentId: 'a1', childCount: 0 })], [e('s1', 'dir:B', 2), e('s1', 'a2', 1, 'calls')]);
      default:
        return EMPTY;
    }
  };
  return { overview, expand };
}

/** `count` root dirs of 500 files each; the first file of each dir is a hub. */
function bigGraph(count: number) {
  const dirs = Array.from({ length: count }, (_, i) => n(`dir:d${i}`, { childCount: 500 }));
  return {
    overview: () => page(dirs),
    expand: (id: string): GraphViewPage =>
      page(Array.from({ length: 500 }, (_, i) => n(`${id}/f${i}`, { kind: 'file', parentId: id, childCount: 0, hub: i === 0 }))),
  };
}

function makeApi(graph: { overview: (o?: GraphOverviewOptions) => GraphViewPage; expand: (id: string, o?: GraphExpandOptions) => GraphViewPage }) {
  return {
    codeGraphOverview: vi.fn((_p: string, o?: GraphOverviewOptions) => Promise.resolve(graph.overview(o))),
    codeGraphExpand: vi.fn((_p: string, id: string, o?: GraphExpandOptions) => Promise.resolve(graph.expand(id, o))),
  };
}

function setup(api: ReturnType<typeof makeApi>): GraphViewStore {
  TestBed.configureTestingModule({ providers: [GraphViewStore, { provide: ElectronApiService, useValue: api }] });
  return TestBed.inject(GraphViewStore);
}

const ids = (store: GraphViewStore) => store.nodes().map((x) => x.id);
const sortedEdges = (edges: readonly GraphViewEdge[]) => [...edges].sort((a, b) => edgeId(a).localeCompare(edgeId(b)));

describe('GraphViewStore (S-44 T-510)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('loadOverview', () => {
    it('loads the root dirs and their aggregated edges', async () => {
      const api = makeApi(smallGraph());
      const store = setup(api);
      const loading = store.loadOverview(P);
      expect(store.loading()).toBe(true);
      await loading;

      expect(api.codeGraphOverview).toHaveBeenCalledWith(P);
      expect(ids(store)).toEqual(['dir:A', 'dir:B', 'dir:C']);
      expect(store.edges()).toEqual([e('dir:A', 'dir:B', 3), e('dir:B', 'dir:C', 1)]);
      expect(store.visibleCount()).toBe(3);
      expect(store.loading()).toBe(false);
      expect(store.empty()).toBe(false);
      expect(store.error()).toBeNull();
      expect(store.expanded().size).toBe(0);
    });

    it('flags an empty graph', async () => {
      const store = setup(makeApi({ overview: () => EMPTY, expand: () => EMPTY }));
      await store.loadOverview(P);
      expect(store.empty()).toBe(true);
      expect(store.nodes()).toEqual([]);
    });

    it('adds a synthetic "more" node when the root has more entries, and showMore continues by offset', async () => {
      const first = page([n('dir:A'), n('dir:B')], [e('dir:A', 'dir:B')], { total: 5, hasMore: true });
      const second = page([n('dir:C'), n('dir:D')], [e('dir:C', 'dir:A', 2)], { total: 5, hasMore: true });
      const third = page([n('dir:E')], [], { total: 5, hasMore: false });
      const api = makeApi({
        overview: (o) => (o?.offset === 2 ? second : o?.offset === 4 ? third : first),
        expand: () => EMPTY,
      });
      const store = setup(api);
      await store.loadOverview(P);

      expect(ids(store)).toEqual(['dir:A', 'dir:B', moreNodeId(null, 2)]);
      const more = store.nodes()[2];
      expect(more).toMatchObject({ kind: 'more', offset: 2, remaining: 3 });

      await store.showMore(null, 2);
      expect(api.codeGraphOverview).toHaveBeenLastCalledWith(P, { offset: 2 });
      expect(ids(store)).toEqual(['dir:A', 'dir:B', 'dir:C', 'dir:D', moreNodeId(null, 4)]);
      expect(store.edges()).toContainEqual(e('dir:C', 'dir:A', 2));

      await store.showMore(null, 4);
      expect(ids(store)).toEqual(['dir:A', 'dir:B', 'dir:C', 'dir:D', 'dir:E']);
    });

    it('sets error without throwing when the overview fails', async () => {
      const api = makeApi(smallGraph());
      api.codeGraphOverview.mockRejectedValueOnce(new Error("Error invoking remote method 'code-graph:overview': Error: boom"));
      const store = setup(api);
      await store.loadOverview(P);
      expect(store.error()).toContain('boom');
      expect(store.loading()).toBe(false);
      expect(store.nodes()).toEqual([]);
    });

    it('drops a late overview of a previous project', async () => {
      const slow = deferred<GraphViewPage>();
      const api = makeApi(smallGraph());
      api.codeGraphOverview.mockReturnValueOnce(slow.promise);
      const store = setup(api);
      const old = store.loadOverview('/ws/old');
      await store.loadOverview(P);
      slow.resolve(page([n('dir:OLD')]));
      await old;
      expect(ids(store)).toEqual(['dir:A', 'dir:B', 'dir:C']);
      expect(store.loading()).toBe(false);
    });

    it('records edgesTruncated from any page', async () => {
      const store = setup(makeApi({ overview: () => page([n('dir:A')], [], { edgesTruncated: true }), expand: () => EMPTY }));
      await store.loadOverview(P);
      expect(store.edgesTruncated()).toBe(true);
    });
  });

  describe('expand', () => {
    it('replaces the node by its children, sending the other visible ids', async () => {
      const api = makeApi(smallGraph());
      const store = setup(api);
      await store.loadOverview(P);
      await store.expand('dir:A');

      expect(api.codeGraphExpand).toHaveBeenCalledWith(P, 'dir:A', { visibleIds: ['dir:B', 'dir:C'] });
      expect(ids(store)).toEqual(['a1', 'a2', 'dir:B', 'dir:C']);
      expect(sortedEdges(store.edges())).toEqual(sortedEdges([
        e('dir:B', 'dir:C', 1), e('a1', 'dir:B', 2), e('a2', 'dir:B', 1), e('a1', 'a2', 1, 'imports'),
      ]));
      expect([...store.expanded()]).toEqual(['dir:A']);
      expect(store.visibleCount()).toBe(4);
    });

    it('does not request twice: concurrent calls share one request and an expanded node is not re-fetched', async () => {
      const slow = deferred<GraphViewPage>();
      const api = makeApi(smallGraph());
      const store = setup(api);
      await store.loadOverview(P);
      api.codeGraphExpand.mockReturnValueOnce(slow.promise);

      const p1 = store.expand('dir:A');
      const p2 = store.expand('dir:A');
      slow.resolve(smallGraph().expand('dir:A', { visibleIds: ['dir:B', 'dir:C'] }));
      await Promise.all([p1, p2]);
      await store.expand('dir:A');

      expect(api.codeGraphExpand).toHaveBeenCalledTimes(1);
      expect(ids(store)).toEqual(['a1', 'a2', 'dir:B', 'dir:C']);
    });

    it('never duplicates nodes or edges already on screen', async () => {
      const api = makeApi({
        overview: () => page([n('dir:A'), n('x', { kind: 'file', childCount: 0 })], [e('dir:A', 'x')]),
        expand: () => page([n('x', { kind: 'file', childCount: 0 }), n('a1', { kind: 'file', childCount: 0 })], [e('a1', 'x'), e('a1', 'x')]),
      });
      const store = setup(api);
      await store.loadOverview(P);
      await store.expand('dir:A');
      expect(ids(store)).toEqual(['a1', 'x']);
      expect(store.edges()).toEqual([e('a1', 'x')]);
    });

    it('leaves the node alone when it has no children or the page is empty', async () => {
      const api = makeApi({ overview: () => page([n('dir:A'), n('leaf', { kind: 'function', childCount: 0 })]), expand: () => EMPTY });
      const store = setup(api);
      await store.loadOverview(P);
      await store.expand('leaf');
      expect(api.codeGraphExpand).not.toHaveBeenCalled();
      await store.expand('dir:A');
      expect(ids(store)).toEqual(['dir:A', 'leaf']);
      expect(store.expanded().size).toBe(0);
    });

    it('sets error and keeps the displayed graph when the expansion fails', async () => {
      const api = makeApi(smallGraph());
      const store = setup(api);
      await store.loadOverview(P);
      const nodes = store.nodes();
      const edges = store.edges();
      api.codeGraphExpand.mockRejectedValueOnce(new Error('CODE_GRAPH_NOT_CREATED'));
      await store.expand('dir:A');
      expect(store.error()).toContain('CODE_GRAPH_NOT_CREATED');
      expect(store.nodes()).toEqual(nodes);
      expect(store.edges()).toEqual(edges);
      expect(store.expanded().size).toBe(0);

      await store.expand('dir:A');
      expect(store.expanded().has('dir:A')).toBe(true);
    });

    it('drops a late response for a node collapsed meanwhile', async () => {
      const slow = deferred<GraphViewPage>();
      const api = makeApi(smallGraph());
      const store = setup(api);
      await store.loadOverview(P);
      await store.expand('dir:A');
      const before = { nodes: store.nodes(), edges: store.edges() };
      api.codeGraphExpand.mockReturnValueOnce(slow.promise);

      const pending = store.expand('a1');
      store.collapse('dir:A');
      slow.resolve(smallGraph().expand('a1', undefined));
      await pending;

      expect(ids(store)).toEqual(['dir:A', 'dir:B', 'dir:C']);
      expect(store.expanded().size).toBe(0);
      expect(before.nodes.length).toBe(4);
    });

    it('drops a late expansion from a previous project', async () => {
      const slow = deferred<GraphViewPage>();
      const api = makeApi(smallGraph());
      const store = setup(api);
      await store.loadOverview('/ws/old');
      api.codeGraphExpand.mockReturnValueOnce(slow.promise);
      const pending = store.expand('dir:A');
      await store.loadOverview(P);
      slow.resolve(smallGraph().expand('dir:A', { visibleIds: [] }));
      await pending;
      expect(ids(store)).toEqual(['dir:A', 'dir:B', 'dir:C']);
      expect(store.expanded().size).toBe(0);
    });

    it('continues a big expansion with a "more" node and showMore(parent, offset)', async () => {
      const kids = (from: number, to: number) =>
        Array.from({ length: to - from }, (_, i) => n(`f${from + i}`, { kind: 'file', parentId: 'dir:A', childCount: 0 }));
      const api = makeApi({
        overview: () => page([n('dir:A', { childCount: 700 }), n('dir:B')]),
        expand: (_id, o) => (o?.offset === 500
          ? page(kids(500, 700), [e('f600', 'dir:B')], { total: 700 })
          : page(kids(0, 500), [], { total: 700, hasMore: true })),
      });
      const store = setup(api);
      await store.loadOverview(P);
      await store.expand('dir:A');
      const moreId = moreNodeId('dir:A', 500);
      expect(ids(store)).toContain(moreId);
      expect(store.nodes().find((x) => x.id === moreId)).toMatchObject({ kind: 'more', parentId: 'dir:A', offset: 500, remaining: 200 });

      await store.showMore('dir:A', 500);
      const call = api.codeGraphExpand.mock.calls.at(-1);
      expect(call?.[1]).toBe('dir:A');
      expect(call?.[2]?.offset).toBe(500);
      expect(call?.[2]?.visibleIds).toContain('dir:B');
      expect(ids(store)).not.toContain(moreId);
      expect(store.visibleCount()).toBe(701);
      expect(store.edges()).toContainEqual(e('f600', 'dir:B'));

      store.collapse('dir:A');
      expect(ids(store)).toEqual(['dir:A', 'dir:B']);
    });
  });

  describe('collapse', () => {
    it('round-trips exactly: expand then collapse returns the previous nodes and edges', async () => {
      const store = setup(makeApi(smallGraph()));
      await store.loadOverview(P);
      const before = { nodes: store.nodes(), edges: store.edges() };
      await store.expand('dir:A');
      store.collapse('dir:A');
      expect(store.nodes()).toEqual(before.nodes);
      expect(store.edges()).toEqual(before.edges);
      expect(store.expanded().size).toBe(0);
      expect(store.visibleCount()).toBe(3);
    });

    it('round-trips exactly through nested expansions (dir → file → symbol)', async () => {
      const store = setup(makeApi(smallGraph()));
      await store.loadOverview(P);
      const root = { nodes: store.nodes(), edges: store.edges() };
      await store.expand('dir:A');
      const level1 = { nodes: store.nodes(), edges: store.edges() };
      await store.expand('a1');
      expect(ids(store)).toEqual(['s1', 'a2', 'dir:B', 'dir:C']);

      store.collapse('a1');
      expect(store.nodes()).toEqual(level1.nodes);
      expect(store.edges()).toEqual(level1.edges);

      await store.expand('a1');
      store.collapse('dir:A');
      expect(store.nodes()).toEqual(root.nodes);
      expect(store.edges()).toEqual(root.edges);
      expect(store.expanded().size).toBe(0);
    });

    it('re-aggregates crossing edges when expansions are collapsed out of order', async () => {
      const store = setup(makeApi(smallGraph()));
      await store.loadOverview(P);
      const root = { nodes: store.nodes(), edges: store.edges() };
      await store.expand('dir:A');
      await store.expand('dir:B');
      expect(ids(store)).toEqual(['a1', 'a2', 'b1', 'b2', 'dir:C']);

      store.collapse('dir:A');
      expect(ids(store)).toEqual(['dir:A', 'b1', 'b2', 'dir:C']);
      expect(sortedEdges(store.edges())).toEqual(sortedEdges([
        e('dir:A', 'b1', 2), e('dir:A', 'b2', 1), e('b1', 'dir:C', 1),
      ]));

      store.collapse('dir:B');
      expect(store.nodes()).toEqual(root.nodes);
      expect(sortedEdges(store.edges())).toEqual(sortedEdges(root.edges));
    });

    it('moves the selection to the collapsed node when it was inside the subtree', async () => {
      const store = setup(makeApi(smallGraph()));
      await store.loadOverview(P);
      await store.expand('dir:A');
      store.select('a2');
      store.collapse('dir:A');
      expect(store.selectedId()).toBe('dir:A');
    });

    it('ignores a node that is not expanded', async () => {
      const store = setup(makeApi(smallGraph()));
      await store.loadOverview(P);
      const before = store.nodes();
      store.collapse('dir:B');
      store.collapse('nope');
      expect(store.nodes()).toBe(before);
    });
  });

  describe('visible cap and LRU', () => {
    it(`never exceeds ${VISIBLE_NODE_CAP} visible nodes: collapses the least recently used expansion and leaves a notice`, async () => {
      const store = setup(makeApi(bigGraph(11)));
      await store.loadOverview(P);
      for (let i = 0; i < 9; i++) await store.expand(`dir:d${i}`);
      expect(store.notice()).toBeNull();
      expect(store.visibleCount()).toBe(4502);

      await store.expand('dir:d9');
      expect(store.visibleCount()).toBeLessThanOrEqual(VISIBLE_NODE_CAP);
      expect(store.expanded().has('dir:d0')).toBe(false);
      expect(store.expanded().has('dir:d9')).toBe(true);
      expect(ids(store)).toContain('dir:d0');
      expect(store.notice()).toEqual({ key: 'codeGraph.canvas.collapsed_notice', params: { count: 1 } });

      store.dismissNotice();
      expect(store.notice()).toBeNull();
    });

    it('treats selecting inside an expansion as a use (LRU)', async () => {
      const store = setup(makeApi(bigGraph(11)));
      await store.loadOverview(P);
      for (let i = 0; i < 9; i++) await store.expand(`dir:d${i}`);
      store.select('dir:d0/f3');
      await store.expand('dir:d9');
      expect(store.expanded().has('dir:d0')).toBe(true);
      expect(store.expanded().has('dir:d1')).toBe(false);
    });

    it(`sends at most ${VISIBLE_IDS_LIMIT} visible ids: selected, hubs, roots and the newest expansions first`, async () => {
      const api = makeApi(bigGraph(11));
      const store = setup(api);
      await store.loadOverview(P);
      for (let i = 0; i < 5; i++) await store.expand(`dir:d${i}`);
      store.select('dir:d0/f7');
      await store.expand('dir:d5');

      const sent = api.codeGraphExpand.mock.calls.at(-1)?.[2]?.visibleIds ?? [];
      expect(sent).toHaveLength(VISIBLE_IDS_LIMIT);
      expect(new Set(sent).size).toBe(sent.length);
      expect(sent).not.toContain('dir:d5');
      expect(sent).toContain('dir:d0/f7');
      expect(sent).toContain('dir:d0/f0');
      expect(sent).toContain('dir:d10');
      expect(sent).toContain('dir:d4/f499');
      expect(sent).toContain('dir:d0/f499');
      expect(sent).toContain('dir:d1/f0');
      expect(sent).not.toContain('dir:d1/f499');
    });
  });

  describe('revealNode', () => {
    it('expands the ancestors in order, awaiting each, then selects the node', async () => {
      const api = makeApi(smallGraph());
      const store = setup(api);
      await store.loadOverview(P);
      const gates = [deferred<GraphViewPage>(), deferred<GraphViewPage>()];
      api.codeGraphExpand.mockReturnValueOnce(gates[0]?.promise ?? Promise.resolve(EMPTY));
      api.codeGraphExpand.mockReturnValueOnce(gates[1]?.promise ?? Promise.resolve(EMPTY));

      const done = store.revealNode('s1', ['dir:A', 'a1']);
      await flush();
      expect(api.codeGraphExpand.mock.calls.map((c) => c[1])).toEqual(['dir:A']);

      gates[0]?.resolve(smallGraph().expand('dir:A', { visibleIds: ['dir:B'] }));
      await flush();
      expect(api.codeGraphExpand.mock.calls.map((c) => c[1])).toEqual(['dir:A', 'a1']);
      expect(store.selectedId()).toBeNull();

      gates[1]?.resolve(smallGraph().expand('a1', undefined));
      await done;
      expect(store.selectedId()).toBe('s1');
      expect([...store.expanded()]).toEqual(['dir:A', 'a1']);
    });

    it('skips ancestors already expanded', async () => {
      const api = makeApi(smallGraph());
      const store = setup(api);
      await store.loadOverview(P);
      await store.expand('dir:A');
      await store.revealNode('a2', ['dir:A']);
      expect(api.codeGraphExpand).toHaveBeenCalledTimes(1);
      expect(store.selectedId()).toBe('a2');
    });

    it('stops when the project changes mid-way', async () => {
      const slow = deferred<GraphViewPage>();
      const api = makeApi(smallGraph());
      const store = setup(api);
      await store.loadOverview(P);
      api.codeGraphExpand.mockReturnValueOnce(slow.promise);
      const done = store.revealNode('s1', ['dir:A', 'a1']);
      store.reset();
      slow.resolve(smallGraph().expand('dir:A', { visibleIds: ['dir:B'] }));
      await done;
      expect(api.codeGraphExpand).toHaveBeenCalledTimes(1);
      expect(store.selectedId()).toBeNull();
      expect(store.nodes()).toEqual([]);
    });
  });

  describe('select, reset and change events', () => {
    it('select sets and clears the selection', async () => {
      const store = setup(makeApi(smallGraph()));
      await store.loadOverview(P);
      store.select('dir:B');
      expect(store.selectedId()).toBe('dir:B');
      store.select(null);
      expect(store.selectedId()).toBeNull();
    });

    it('reset clears everything', async () => {
      const store = setup(makeApi(smallGraph()));
      await store.loadOverview(P);
      await store.expand('dir:A');
      store.select('a1');
      store.reset();
      expect(store.nodes()).toEqual([]);
      expect(store.edges()).toEqual([]);
      expect(store.expanded().size).toBe(0);
      expect(store.selectedId()).toBeNull();
      expect(store.visibleCount()).toBe(0);
      expect(store.empty()).toBe(false);
      expect(store.error()).toBeNull();
    });

    it('emits the deltas a renderer needs, and stops after unsubscribing', async () => {
      const store = setup(makeApi(smallGraph()));
      const changes: GraphViewChange[] = [];
      const off = store.onChange((c) => changes.push(c));
      await store.loadOverview(P);
      await store.expand('dir:A');
      store.collapse('dir:A');
      off();
      store.reset();

      expect(changes.map((c) => c.type)).toEqual(['reset', 'explode', 'collapse']);
      const [reset, explode, collapse] = changes;
      expect(reset?.type === 'reset' && reset.nodes.map((x) => x.id)).toEqual(['dir:A', 'dir:B', 'dir:C']);
      expect(explode?.type === 'explode' && explode.parentId).toBe('dir:A');
      expect(explode?.type === 'explode' && explode.nodes.map((x) => x.id)).toEqual(['a1', 'a2']);
      expect(explode?.type === 'explode' && explode.edges).toHaveLength(3);
      if (collapse?.type !== 'collapse') throw new Error('expected a collapse');
      expect(collapse.node.id).toBe('dir:A');
      expect([...collapse.removedIds].sort()).toEqual(['a1', 'a2']);
      expect(collapse.restoredEdges).toEqual([e('dir:A', 'dir:B', 3)]);
    });
  });
});
