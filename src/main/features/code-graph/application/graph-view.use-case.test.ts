import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GRAPH_EXPAND_LIMIT,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type GraphViewEdge,
  type GraphViewPage,
} from '../../../../shared/domain/code-graph';
import { openGraphDb, type GraphDb } from '../engine/db/connection';
import { GraphQueries } from '../engine/db/queries';
import { makeNodeId } from '../engine/extraction/node-id';
import { computeCommunities, findHubs, persistCommunities, readCommunities } from '../engine/graph/communities';
import { bestOf } from '../engine/graph/test-graph';
import { indexProject } from '../engine/indexer/orchestrator';
import { CodeGraphStore } from '../infrastructure/code-graph-store';
import { GraphViewUseCase } from './graph-view.use-case';

const AGG: EdgeKind[] = ['imports', 'calls', 'instantiates', 'extends', 'implements', 'references'];
const EMPTY: GraphViewPage = { nodes: [], edges: [], total: 0, hasMore: false };

function must<T>(v: T | undefined | null, what = 'value'): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}

const FIXTURE: Record<string, string> = {
  'index.ts': "import { run } from './src/app/main';\n\nrun();\n",
  'src/app/main.ts': [
    "import { helper } from '../lib/util';",
    "import { Greeter } from '../lib/greeter';",
    '',
    'export function run(): string {',
    '  const g = new Greeter();',
    "  return g.greet(helper('x'));",
    '}',
    '',
  ].join('\n'),
  'src/app/nested/deep.ts': [
    "import { helper } from '../../lib/util';",
    '',
    'export function deep(): string {',
    "  return helper('deep');",
    '}',
    '',
  ].join('\n'),
  'src/lib/util.ts': [
    '/** Trims a string. */',
    'export function helper(s: string): string {',
    '  return s.trim();',
    '}',
    '',
    'export function unused(): number {',
    '  return 1;',
    '}',
    '',
  ].join('\n'),
  'src/lib/greeter.ts': [
    "import { helper } from './util';",
    '',
    'export class Greeter {',
    '  greet(name: string): string {',
    '    return this.wrap(helper(name));',
    '  }',
    '',
    '  wrap(s: string): string {',
    '    return `<${s}>`;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'py/helpers.py': 'def shout(text):\n    return text.upper()\n',
  'py/tool.py': [
    'from helpers import shout',
    '',
    '',
    'class Tool:',
    '    def run(self):',
    "        return shout('x')",
    '',
    '',
    'def main():',
    '    return Tool().run()',
    '',
  ].join('\n'),
  'web/util.js': 'function fmt(x) {\n  return String(x);\n}\n\nmodule.exports = { fmt };\n',
  'web/app.js': "const { fmt } = require('./util');\n\nfunction start() {\n  return fmt(1);\n}\n\nmodule.exports = { start };\n",
};

interface Env {
  deviaDir: string;
  project: string;
  store: CodeGraphStore;
  dispose(): void;
}

function makeEnv(): Env {
  const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-view-devia-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-view-project-'));
  return {
    deviaDir,
    project,
    store: new CodeGraphStore(() => deviaDir),
    dispose() {
      fs.rmSync(deviaDir, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    },
  };
}

async function indexFixture(env: Env, files: Record<string, string>): Promise<void> {
  for (const [rel, src] of Object.entries(files)) {
    const abs = path.join(env.project, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, src);
  }
  await indexProject({ root: env.project, dataDir: env.store.dataDir(env.project) });
}

function withDb<T>(env: Env, fn: (q: GraphQueries) => T, readonly = true): T {
  const db = openGraphDb(env.store.dbPath(env.project), { readonly });
  try {
    return fn(new GraphQueries(db));
  } finally {
    db.close();
  }
}

/** Brute-force reference: every real edge folded onto its nearest visible node, from raw rows. */
function oracle(q: GraphQueries, visible: Set<string>): Map<string, number> {
  const fileOf = new Map(q.nodeSummaries().map((n) => [n.id, n.filePath]));
  const parent = new Map(q.edgesOfKinds(['contains']).map((e) => [e.target, e.source]));
  const rep = (id: string): string | undefined => {
    for (let cur: string | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      if (visible.has(cur)) return cur;
    }
    const segs = must(fileOf.get(id), id).split('/');
    for (let i = segs.length - 1; i > 0; i--) {
      const d = `dir:${segs.slice(0, i).join('/')}`;
      if (visible.has(d)) return d;
    }
    return undefined;
  };
  const out = new Map<string, number>();
  for (const e of q.edgesOfKinds(AGG)) {
    const s = rep(e.source);
    const t = rep(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    out.set(`${s} -> ${t}`, (out.get(`${s} -> ${t}`) ?? 0) + 1);
  }
  return out;
}

function asMap(edges: GraphViewEdge[]): Map<string, number> {
  for (const e of edges) expect(e.kind).toBe('aggregate');
  return new Map(edges.map((e) => [`${e.source} -> ${e.target}`, e.weight]));
}

/** Expected expand edges: touching a new child, never touching the expanded node or its ancestors. */
function expectedExpand(
  q: GraphQueries,
  visible: string[],
  page: GraphViewPage,
  blocked: string[],
): Map<string, number> {
  const fresh = new Set(page.nodes.map((n) => n.id));
  const all = oracle(q, new Set([...visible, ...fresh]));
  const out = new Map<string, number>();
  for (const [k, w] of all) {
    const [s, t] = k.split(' -> ') as [string, string];
    if (!fresh.has(s) && !fresh.has(t)) continue;
    if (blocked.includes(s) || blocked.includes(t)) continue;
    out.set(k, w);
  }
  return out;
}

describe('GraphViewUseCase on a real multi-language project', () => {
  let env: Env;
  let uc: GraphViewUseCase;
  const idOf = (file: string, qualifiedName?: string): string =>
    withDb(env, (q) => {
      const n = q.nodesInFile(file).find((x) => (qualifiedName === undefined ? x.kind === 'file' : x.qualifiedName === qualifiedName));
      return must(n, `${file}::${qualifiedName ?? 'file'}`).id;
    });

  beforeAll(async () => {
    env = makeEnv();
    await indexFixture(env, FIXTURE);
    uc = new GraphViewUseCase({ store: env.store });
  }, 60_000);
  afterAll(() => env.dispose());

  describe('overview', () => {
    it('returns the root entries, dirs first, with counts and no parent', () => {
      const page = uc.overview(env.project);
      expect(page.nodes.map((n) => n.id)).toEqual(['dir:py', 'dir:src', 'dir:web', idOf('index.ts')]);
      expect(page.total).toBe(4);
      expect(page.hasMore).toBe(false);
      const src = must(page.nodes.find((n) => n.id === 'dir:src'));
      expect(src).toMatchObject({ kind: 'dir', label: 'src', path: 'src', childCount: 2, fileCount: 4 });
      expect(src.symbolCount).toBeGreaterThanOrEqual(7);
      expect(src).not.toHaveProperty('parentId');
      const index = must(page.nodes.find((n) => n.path === 'index.ts'));
      expect(index).toMatchObject({ kind: 'file', label: 'index.ts', language: 'typescript' });
      expect(index).not.toHaveProperty('parentId');
    });

    it('aggregates the real edges between root entries with exact weights', () => {
      const page = uc.overview(env.project);
      const got = asMap(page.edges);
      const want = withDb(env, (q) => oracle(q, new Set(page.nodes.map((n) => n.id))));
      expect(got).toEqual(want);
      expect(got.get(`${idOf('index.ts')} -> dir:src`)).toBeGreaterThanOrEqual(2);
      expect(got.has('dir:src -> dir:py')).toBe(false);
    });
  });

  describe('expand', () => {
    it('expands a dir into its subdirs and files, mapping edges onto visible root entries', () => {
      const overview = uc.overview(env.project);
      const visible = overview.nodes.map((n) => n.id);
      const page = uc.expand(env.project, 'dir:src', { visibleIds: visible });
      expect(page.nodes.map((n) => n.id)).toEqual(['dir:src/app', 'dir:src/lib']);
      expect(page.nodes.every((n) => n.parentId === 'dir:src')).toBe(true);
      expect(page).toMatchObject({ total: 2, hasMore: false });
      const want = withDb(env, (q) => expectedExpand(q, visible, page, ['dir:src']));
      expect(asMap(page.edges)).toEqual(want);
      expect(want.get(`${idOf('index.ts')} -> dir:src/app`)).toBeGreaterThanOrEqual(1);
    });

    it('expands a nested dir: subdir before file, edges to a visible sibling dir', () => {
      const visible = ['dir:py', 'dir:src', 'dir:web', idOf('index.ts'), 'dir:src/app', 'dir:src/lib'];
      const page = uc.expand(env.project, 'dir:src/app', { visibleIds: visible });
      expect(page.nodes.map((n) => n.id)).toEqual(['dir:src/app/nested', idOf('src/app/main.ts')]);
      const main = must(page.nodes[1]);
      expect(main).toMatchObject({ kind: 'file', label: 'main.ts', path: 'src/app/main.ts', parentId: 'dir:src/app' });
      const want = withDb(env, (q) => expectedExpand(q, visible, page, ['dir:src/app', 'dir:src']));
      expect(asMap(page.edges)).toEqual(want);
      expect(want.has(`${idOf('src/app/main.ts')} -> dir:src/lib`)).toBe(true);
      expect(want.has(`dir:src/app/nested -> dir:src/lib`)).toBe(true);
    });

    it('expands a file into its symbols and a class into its members', () => {
      const greeterFile = idOf('src/lib/greeter.ts');
      const greeter = idOf('src/lib/greeter.ts', 'Greeter');
      const filePage = uc.expand(env.project, greeterFile, { visibleIds: [] });
      expect(filePage.nodes.map((n) => n.id)).toContain(greeter);
      const cls = must(filePage.nodes.find((n) => n.id === greeter));
      expect(cls).toMatchObject({ kind: 'class', label: 'Greeter', parentId: greeterFile, path: 'src/lib/greeter.ts', childCount: 2, exported: true, language: 'typescript', line: 3 });

      const members = uc.expand(env.project, greeter, { visibleIds: [greeterFile] });
      expect(members.nodes.map((n) => n.label)).toEqual(['greet', 'wrap']);
      expect(members.nodes.every((n) => n.parentId === greeter && n.kind === 'method')).toBe(true);
      const greet = idOf('src/lib/greeter.ts', 'Greeter.greet');
      const wrap = idOf('src/lib/greeter.ts', 'Greeter.wrap');
      expect(asMap(members.edges).get(`${greet} -> ${wrap}`)).toBe(1);
    });

    it('maps the far endpoint to its nearest visible node: symbol, else file, else dir', () => {
      const greeter = idOf('src/lib/greeter.ts', 'Greeter');
      const greeterFile = idOf('src/lib/greeter.ts');
      const greet = idOf('src/lib/greeter.ts', 'Greeter.greet');
      const helper = idOf('src/lib/util.ts', 'helper');
      const utilFile = idOf('src/lib/util.ts');
      const cases: [string[], string][] = [
        [['dir:src', 'dir:src/lib', greeterFile, helper, 'dir:src/app'], helper],
        [['dir:src', 'dir:src/lib', greeterFile, utilFile, idOf('src/app/main.ts')], utilFile],
        [['dir:src', 'dir:src/lib', greeterFile], 'dir:src/lib'],
        [['dir:src', greeterFile], 'dir:src'],
      ];
      for (const [visible, helperRep] of cases) {
        const page = uc.expand(env.project, greeter, { visibleIds: visible });
        const got = asMap(page.edges);
        const want = withDb(env, (q) => expectedExpand(q, visible, page, [greeter, greeterFile, 'dir:src/lib', 'dir:src']));
        expect(got).toEqual(want);
        if (helperRep.startsWith('dir:')) expect([...got.keys()].some((k) => k.includes(helperRep))).toBe(false);
        else expect(got.get(`${greet} -> ${helperRep}`)).toBe(1);
      }
    });

    it('returns an empty page for unknown, malformed or leaf ids, never an error', () => {
      for (const id of ['nope', 'dir:nope', 'dir:', 'dir:src/', 'dir:/src', 'dir:src//app', idOf('src/lib/util.ts', 'helper')]) {
        expect(uc.expand(env.project, id, { visibleIds: [] })).toEqual(EMPTY);
      }
    });
  });

  describe('nodeDetail', () => {
    it('describes a symbol: ancestors to reveal it, callers, callees, impact and community', () => {
      const greet = idOf('src/lib/greeter.ts', 'Greeter.greet');
      const d = uc.nodeDetail(env.project, greet);
      if (d?.kind !== 'symbol') throw new Error('expected a symbol detail');
      expect(d.node.id).toBe(greet);
      expect(d.ancestors).toEqual(['dir:src', 'dir:src/lib', idOf('src/lib/greeter.ts'), idOf('src/lib/greeter.ts', 'Greeter')]);
      expect(d.callees.map((n) => n.qualifiedName)).toEqual(expect.arrayContaining(['Greeter.wrap', 'helper']));
      expect(d.impact.files[0]).toBe('src/lib/greeter.ts');
      expect(d.impact).toMatchObject({ count: d.impact.files.length, truncated: false });
      const communities = withDb(env, (q) => readCommunities(q));
      expect(d.community).toBe(communities.get('src/lib/greeter.ts'));
    });

    it('carries the docstring of a top-level function and ends its ancestors at the file', () => {
      const d = uc.nodeDetail(env.project, idOf('src/lib/util.ts', 'helper'));
      if (d?.kind !== 'symbol') throw new Error('expected a symbol detail');
      expect(d.ancestors).toEqual(['dir:src', 'dir:src/lib', idOf('src/lib/util.ts')]);
      expect(d.docstring).toContain('Trims a string');
      expect(d.callers.map((n) => n.qualifiedName)).toEqual(expect.arrayContaining(['run', 'deep', 'Greeter.greet']));
      expect(d.impact.files[0]).toBe('src/lib/util.ts');
      expect(d.impact.files).toEqual(expect.arrayContaining(['src/app/main.ts', 'src/app/nested/deep.ts', 'src/lib/greeter.ts']));
      expect(d.impact).toMatchObject({ count: d.impact.files.length, truncated: false });
    });

    it('describes a directory', () => {
      const d = uc.nodeDetail(env.project, 'dir:src/lib');
      if (d?.kind !== 'dir') throw new Error('expected a dir detail');
      expect(d).toMatchObject({ id: 'dir:src/lib', path: 'src/lib', ancestors: ['dir:src'], fileCount: 2, languages: { typescript: 2 } });
      expect(d.symbolCount).toBeGreaterThanOrEqual(5);
      expect(d.topHubs.length).toBeGreaterThan(0);
      expect(d.topHubs.length).toBeLessThanOrEqual(5);
      expect(d.topHubs.every((n) => n.filePath.startsWith('src/lib/') && n.kind !== 'file')).toBe(true);
      expect(d.communities.reduce((s, c) => s + c.files, 0)).toBe(2);
    });

    it('describes a file with its importers and imports', () => {
      const d = uc.nodeDetail(env.project, idOf('src/lib/util.ts'));
      if (d?.kind !== 'file') throw new Error('expected a file detail');
      expect(d).toMatchObject({ path: 'src/lib/util.ts', language: 'typescript', ancestors: ['dir:src', 'dir:src/lib'], symbolCount: 2, imports: [], importsCount: 0 });
      expect(d.importedBy.map((f) => f.path)).toEqual(['src/app/main.ts', 'src/app/nested/deep.ts', 'src/lib/greeter.ts']);
      expect(d.importedBy[0]?.id).toBe(idOf('src/app/main.ts'));
      expect(d.importedByCount).toBe(3);
      const main = uc.nodeDetail(env.project, idOf('src/app/main.ts'));
      if (main?.kind !== 'file') throw new Error('expected a file detail');
      expect(main.imports.map((f) => f.path)).toEqual(['src/lib/greeter.ts', 'src/lib/util.ts']);
    });

    it('is undefined for unknown ids', () => {
      for (const id of ['nope', 'dir:nope', 'dir:', 'dir:src/']) expect(uc.nodeDetail(env.project, id)).toBeUndefined();
    });
  });

  describe('search', () => {
    it('merges symbol hits and file path hits with ancestors', () => {
      const res = uc.search(env.project, 'util');
      const ids = res.map((r) => r.node.id);
      expect(ids).toEqual(expect.arrayContaining([idOf('src/lib/util.ts'), idOf('web/util.js')]));
      const file = must(res.find((r) => r.node.id === idOf('src/lib/util.ts')));
      expect(file.ancestors).toEqual(['dir:src', 'dir:src/lib']);
      expect(file.node).toMatchObject({ kind: 'file', path: 'src/lib/util.ts', parentId: 'dir:src/lib' });

      const helper = must(uc.search(env.project, 'helper').find((r) => r.node.label === 'helper'));
      expect(helper.ancestors).toEqual(['dir:src', 'dir:src/lib', idOf('src/lib/util.ts')]);
      expect(helper.node).toMatchObject({ kind: 'function', parentId: idOf('src/lib/util.ts'), path: 'src/lib/util.ts' });
      expect(helper.score).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('returns [] for a blank query', () => {
      expect(uc.search(env.project, '   ')).toEqual([]);
    });
  });

  it('attaches communities to every node and hub flags to the top hubs', () => {
    const { communities, hubs } = withDb(env, (q) => ({
      communities: readCommunities(q),
      hubs: new Set(findHubs(q, { top: 20 }).map((h) => h.nodeId)),
    }));
    const files = uc.expand(env.project, 'dir:src/lib', { visibleIds: [] }).nodes;
    for (const n of files) expect(n.community).toBe(communities.get(n.path));
    const symbols = uc.expand(env.project, idOf('src/lib/util.ts'), { visibleIds: [] }).nodes;
    expect(symbols.length).toBeGreaterThan(0);
    for (const n of symbols) {
      expect(n.community).toBe(communities.get('src/lib/util.ts'));
      expect(n.hub === true).toBe(hubs.has(n.id));
    }
    expect(symbols.some((n) => n.hub === true)).toBe(true);
    const dir = must(uc.overview(env.project).nodes.find((n) => n.id === 'dir:src'));
    expect(typeof dir.community).toBe('number');
  });
});

describe('GraphViewUseCase lifecycle', () => {
  it('answers success-shaped empties when the project has no graph', () => {
    const env = makeEnv();
    try {
      const uc = new GraphViewUseCase({ store: env.store });
      expect(uc.overview(env.project)).toEqual(EMPTY);
      expect(uc.expand(env.project, 'dir:src', { visibleIds: [] })).toEqual(EMPTY);
      expect(uc.nodeDetail(env.project, 'dir:src')).toBeUndefined();
      expect(uc.search(env.project, 'x')).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it('shows a single top-level directory as is, without descending into it', async () => {
    const env = makeEnv();
    try {
      await indexFixture(env, {
        'src/a.ts': "import { b } from './b';\n\nexport const a = (): number => b();\n",
        'src/b.ts': 'export function b(): number {\n  return 1;\n}\n',
      });
      const page = new GraphViewUseCase({ store: env.store }).overview(env.project);
      expect(page.nodes.map((n) => n.id)).toEqual(['dir:src']);
      expect(page).toMatchObject({ total: 1, hasMore: false, edges: [] });
    } finally {
      env.dispose();
    }
  }, 60_000);

  it('returns an empty page for a node that vanished after a re-index', async () => {
    const env = makeEnv();
    try {
      await indexFixture(env, FIXTURE);
      const uc = new GraphViewUseCase({ store: env.store });
      const id = must(uc.expand(env.project, 'dir:web', { visibleIds: [] }).nodes.find((n) => n.label === 'app.js')).id;
      expect(uc.expand(env.project, id, { visibleIds: [] }).nodes.length).toBeGreaterThan(0);
      fs.rmSync(path.join(env.project, 'web'), { recursive: true });
      await indexProject({ root: env.project, dataDir: env.store.dataDir(env.project) });
      expect(uc.expand(env.project, id, { visibleIds: [] })).toEqual(EMPTY);
      expect(uc.expand(env.project, 'dir:web', { visibleIds: [] })).toEqual(EMPTY);
      expect(uc.nodeDetail(env.project, id)).toBeUndefined();
    } finally {
      env.dispose();
    }
  }, 60_000);

  it('opens the graph read-only and closes it on success and on error', async () => {
    const env = makeEnv();
    try {
      await indexFixture(env, FIXTURE);
      const opened: { readonly?: boolean }[] = [];
      let closes = 0;
      const mmaps: number[] = [];
      const uc = new GraphViewUseCase({
        store: env.store,
        openDb: (file, o) => {
          opened.push(o ?? {});
          const db = openGraphDb(file, o);
          const close = db.close.bind(db);
          db.close = (): void => {
            mmaps.push((db.prepare('PRAGMA mmap_size').get() as { mmap_size: number }).mmap_size);
            closes++;
            close();
          };
          return db;
        },
      });
      uc.overview(env.project);
      uc.expand(env.project, 'dir:src', { visibleIds: [] });
      uc.nodeDetail(env.project, 'dir:src');
      uc.search(env.project, 'helper');
      expect(opened).toHaveLength(4);
      expect(opened.every((o) => o.readonly === true)).toBe(true);
      expect(closes).toBe(4);
      expect(mmaps.every((m) => m >= 256 * 1024 * 1024)).toBe(true);

      const close = vi.fn();
      const broken = new GraphViewUseCase({
        store: env.store,
        openDb: () =>
          ({
            exec: () => undefined,
            function: () => undefined,
            prepare: () => {
              throw new Error('boom');
            },
            close,
          }) as unknown as GraphDb,
      });
      expect(() => broken.overview(env.project)).toThrow('boom');
      expect(() => broken.nodeDetail(env.project, 'dir:src')).toThrow('boom');
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      env.dispose();
    }
  }, 60_000);

  it('caches hubs and communities per graph file and recomputes when it changes', async () => {
    const env = makeEnv();
    try {
      await indexFixture(env, FIXTURE);
      const hubs = vi.fn(findHubs);
      const uc = new GraphViewUseCase({ store: env.store, findHubs: hubs });
      const fileId = must(uc.expand(env.project, 'dir:web', { visibleIds: [] }).nodes.find((n) => n.label === 'app.js')).id;
      uc.expand(env.project, fileId, { visibleIds: [] });
      uc.expand(env.project, fileId, { visibleIds: [] });
      uc.search(env.project, 'fmt');
      expect(hubs).toHaveBeenCalledTimes(1);
      expect(uc.overview(env.project).nodes.find((n) => n.id === 'dir:web')?.community).not.toBe(4242);

      withDb(
        env,
        (q) => {
          const all = readCommunities(q);
          for (const k of all.keys()) all.set(k, 4242);
          persistCommunities(q, all);
        },
        false,
      );
      expect(uc.overview(env.project).nodes.find((n) => n.id === 'dir:web')?.community).toBe(4242);
      uc.expand(env.project, fileId, { visibleIds: [] });
      expect(hubs).toHaveBeenCalledTimes(2);
    } finally {
      env.dispose();
    }
  }, 60_000);
});

/*
 * 50k nodes / 150k edges: pkg0..9/mod0..9 hold 42 files each and `big/` holds 800,
 * 10 nodes per file (file, class + 4 methods, 4 functions). Besides the 45k `contains`
 * edges there is one import per file and 100k calls between uniformly random symbols,
 * the worst case for aggregation (no locality, almost every edge crosses files).
 */
describe('GraphViewUseCase on a 50k-node graph', () => {
  let env: Env;
  let uc: GraphViewUseCase;
  const timings: Record<string, number> = {};

  beforeAll(() => {
    env = makeEnv();
    fs.mkdirSync(env.store.dataDir(env.project), { recursive: true });
    const db = openGraphDb(env.store.dbPath(env.project));
    try {
      const q = new GraphQueries(db);
      let a = 7;
      const rand = (): number => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const paths: string[] = [];
      for (let p = 0; p < 10; p++) for (let m = 0; m < 10; m++) for (let f = 0; f < 42; f++) paths.push(`pkg${p}/mod${m}/f${f}.ts`);
      for (let f = 0; f < 800; f++) paths.push(`big/b${String(f).padStart(3, '0')}.ts`);
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      const symbols: string[] = [];
      const fileIds: string[] = [];
      const mk = (p: string, kind: GraphNode['kind'], name: string, line: number): GraphNode => ({
        id: makeNodeId(p, kind, kind === 'file' ? p : name, line),
        kind,
        name: kind === 'file' ? (p.split('/').pop() as string) : name.split('.').pop() as string,
        qualifiedName: kind === 'file' ? p : name,
        filePath: p,
        language: 'typescript',
        startLine: line,
        endLine: line + 1,
        isExported: kind !== 'method',
      });
      for (const p of paths) {
        const file = mk(p, 'file', p, 1);
        const cls = mk(p, 'class', 'Svc', 2);
        nodes.push(file, cls);
        fileIds.push(file.id);
        edges.push({ source: file.id, target: cls.id, kind: 'contains' });
        symbols.push(cls.id);
        for (let i = 0; i < 4; i++) {
          const m = mk(p, 'method', `Svc.m${i}`, 3 + i);
          nodes.push(m);
          edges.push({ source: cls.id, target: m.id, kind: 'contains' });
          symbols.push(m.id);
        }
        for (let i = 0; i < 4; i++) {
          const fn = mk(p, 'function', `fn${i}`, 20 + i);
          nodes.push(fn);
          edges.push({ source: file.id, target: fn.id, kind: 'contains' });
          symbols.push(fn.id);
        }
        q.upsertFile({ path: p, contentHash: 'h', language: 'typescript', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 10, generated: false, isTest: false });
      }
      for (const id of fileIds) edges.push({ source: id, target: fileIds[Math.floor(rand() * fileIds.length)] as string, kind: 'imports' });
      for (let i = 0; i < 100_000; i++) {
        edges.push({
          source: symbols[Math.floor(rand() * symbols.length)] as string,
          target: symbols[Math.floor(rand() * symbols.length)] as string,
          kind: 'calls',
          line: i + 1,
        });
      }
      q.insertNodes(nodes);
      q.insertEdges(edges);
      persistCommunities(q, computeCommunities(q).assignments);
      expect(q.counts()).toMatchObject({ nodes: 50_000, edges: 150_000 });
    } finally {
      db.close();
    }
    uc = new GraphViewUseCase({ store: env.store });
  }, 120_000);

  afterAll(() => {
    const out = process.env['CG_VIEW_PERF_FILE'];
    if (out) fs.writeFileSync(out, JSON.stringify(timings, null, 2));
    env.dispose();
  });

  const overviewIds = (): string[] => uc.overview(env.project).nodes.map((n) => n.id);

  it('overview ≤ 300 ms', () => {
    const cold = new GraphViewUseCase({ store: env.store });
    const start = performance.now();
    cold.overview(env.project);
    timings['overviewCold'] = performance.now() - start;
    const r = bestOf(() => uc.overview(env.project));
    timings['overview'] = r.ms;
    expect(r.value.nodes.map((n) => n.id)).toEqual(['dir:big', ...Array.from({ length: 10 }, (_, i) => `dir:pkg${i}`)]);
    expect(r.value.edges.length).toBeGreaterThan(0);
    expect(r.ms).toBeLessThan(300);
  }, 60_000);

  it('expand of a directory with 800 children ≤ 200 ms', () => {
    const visibleIds = overviewIds();
    // ~70 ms alone, but the parallel main suite can starve it for seconds: sample longer.
    const r = bestOf(() => uc.expand(env.project, 'dir:big', { visibleIds }), 10);
    timings['expand800'] = r.ms;
    expect(r.value.nodes).toHaveLength(GRAPH_EXPAND_LIMIT);
    expect(r.value.edges.length).toBeGreaterThan(0);
    expect(r.ms).toBeLessThan(200);
  }, 60_000);

  it('pages 800 children: 500 + hasMore, then the other 300, no duplicates or gaps', () => {
    const visibleIds = overviewIds();
    const first = uc.expand(env.project, 'dir:big', { visibleIds });
    expect(first).toMatchObject({ total: 800, hasMore: true });
    expect(first.nodes).toHaveLength(500);
    const second = uc.expand(env.project, 'dir:big', { offset: 500, visibleIds: [...visibleIds, ...first.nodes.map((n) => n.id)] });
    expect(second).toMatchObject({ total: 800, hasMore: false });
    expect(second.nodes).toHaveLength(300);
    const labels = [...first.nodes, ...second.nodes].map((n) => n.label);
    expect(labels).toEqual(Array.from({ length: 800 }, (_, i) => `b${String(i).padStart(3, '0')}.ts`));
    expect(uc.expand(env.project, 'dir:big', { offset: 800, visibleIds })).toMatchObject({ nodes: [], total: 800, hasMore: false });
    const secondIds = new Set(second.nodes.map((n) => n.id));
    for (const e of second.edges) expect(secondIds.has(e.source) || secondIds.has(e.target)).toBe(true);
  }, 60_000);

  it('nodeDetail ≤ 300 ms', () => {
    const sample = uc.expand(env.project, must(uc.expand(env.project, 'dir:big', { visibleIds: [] }).nodes[0]).id, { visibleIds: [] }).nodes;
    const target = must(sample.find((n) => n.kind === 'function')).id;
    const r = bestOf(() => uc.nodeDetail(env.project, target));
    timings['nodeDetailSymbol'] = r.ms;
    expect(r.value?.kind).toBe('symbol');
    expect(r.ms).toBeLessThan(300);
    const dir = bestOf(() => uc.nodeDetail(env.project, 'dir:pkg0'));
    timings['nodeDetailDir'] = dir.ms;
    expect(dir.value?.kind).toBe('dir');
    expect(dir.ms).toBeLessThan(300);
  }, 60_000);

  it('search ≤ 300 ms and at most 50 merged results', () => {
    const r = bestOf(() => uc.search(env.project, 'fn1'));
    timings['search'] = r.ms;
    expect(r.value.length).toBeGreaterThan(0);
    expect(r.value.length).toBeLessThanOrEqual(50);
    const mixed = uc.search(env.project, 'b00');
    expect(mixed.some((x) => x.node.kind === 'file')).toBe(true);
    expect(mixed.length).toBeLessThanOrEqual(50);
    expect(r.ms).toBeLessThan(300);
  }, 60_000);
});
