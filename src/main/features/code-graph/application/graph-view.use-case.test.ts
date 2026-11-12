import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GRAPH_EDGE_LIMIT,
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
import {
  PERSISTED_HUBS,
  computeCommunities,
  findHubs,
  persistCommunities,
  persistHubs,
  readCommunities,
  readHubs,
  type Hub,
} from '../engine/graph/communities';
import { bestOf, perfBudget } from '../engine/graph/test-graph';
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

/** A file node plus one function per path; `edges` gets their ids, index-aligned with `paths`. */
function seedPlain(env: Env, paths: string[], edges: (files: string[], fns: string[]) => GraphEdge[]): void {
  fs.mkdirSync(env.store.dataDir(env.project), { recursive: true });
  const db = openGraphDb(env.store.dbPath(env.project));
  try {
    const q = new GraphQueries(db);
    const nodes: GraphNode[] = [];
    const files: string[] = [];
    const fns: string[] = [];
    const contains: GraphEdge[] = [];
    for (const p of paths) {
      const base = { filePath: p, language: 'typescript' as const, endLine: 9, isExported: true };
      const file: GraphNode = { ...base, id: makeNodeId(p, 'file', p, 1), kind: 'file', name: p, qualifiedName: p, startLine: 1 };
      const fn: GraphNode = { ...base, id: makeNodeId(p, 'function', 'fn', 2), kind: 'function', name: 'fn', qualifiedName: 'fn', startLine: 2 };
      nodes.push(file, fn);
      files.push(file.id);
      fns.push(fn.id);
      contains.push({ source: file.id, target: fn.id, kind: 'contains' });
      q.upsertFile({ path: p, contentHash: 'h', language: 'typescript', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 2, generated: false, isTest: false });
    }
    q.insertNodes(nodes);
    q.insertEdges([...contains, ...edges(files, fns)]);
    persistCommunities(q, computeCommunities(q).assignments);
    persistHubs(q, findHubs(q, { top: PERSISTED_HUBS }));
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

  it('attaches communities to every node and hub flags to the top persisted hubs', () => {
    const { communities, hubs } = withDb(env, (q) => ({
      communities: readCommunities(q),
      hubs: new Set(readHubs(q).slice(0, 20).map((h) => h.nodeId)),
    }));
    expect(hubs.size).toBeGreaterThan(0);
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

  it('gives the impact files with their file node ids so the view can reveal them', () => {
    const d = uc.nodeDetail(env.project, idOf('src/lib/util.ts', 'helper'));
    if (d?.kind !== 'symbol') throw new Error('expected a symbol detail');
    expect(d.impact.refs.map((r) => r.path)).toEqual(d.impact.files);
    expect(d.impact.refs[0]).toEqual({ id: idOf('src/lib/util.ts'), path: 'src/lib/util.ts' });
  });
});

describe('GraphViewUseCase generated flags (T-511)', () => {
  let env: Env;
  let uc: GraphViewUseCase;
  const idOf = (file: string): string =>
    withDb(env, (q) => must(q.nodesInFile(file).find((x) => x.kind === 'file'), file).id);

  beforeAll(async () => {
    env = makeEnv();
    await indexFixture(env, {
      'gen/api.generated.ts': 'export function callApi(): number {\n  return 1;\n}\n',
      'gen/client.gen.ts': "import { callApi } from './api.generated';\n\nexport function client(): number {\n  return callApi();\n}\n",
      'mixed/a.generated.ts': 'export const A = 1;\n',
      'mixed/b.ts': "import { A } from './a.generated';\n\nexport function useA(): number {\n  return A;\n}\n",
    });
    uc = new GraphViewUseCase({ store: env.store });
  }, 60_000);
  afterAll(() => env.dispose());

  it('flags a dir whose files are all generated, and generated files, never the rest', () => {
    const root = uc.overview(env.project).nodes;
    expect(must(root.find((n) => n.id === 'dir:gen')).generated).toBe(true);
    expect(must(root.find((n) => n.id === 'dir:mixed'))).not.toHaveProperty('generated');
    const mixed = uc.expand(env.project, 'dir:mixed', { visibleIds: ['dir:gen'] }).nodes;
    expect(must(mixed.find((n) => n.path === 'mixed/a.generated.ts')).generated).toBe(true);
    expect(must(mixed.find((n) => n.path === 'mixed/b.ts'))).not.toHaveProperty('generated');
  });

  it('flags the symbols of a generated file', () => {
    const symbols = uc.expand(env.project, idOf('gen/api.generated.ts'), { visibleIds: [] }).nodes;
    expect(symbols.length).toBeGreaterThan(0);
    for (const s of symbols) expect(s.generated).toBe(true);
    const own = uc.expand(env.project, idOf('mixed/b.ts'), { visibleIds: [] }).nodes;
    for (const s of own) expect(s).not.toHaveProperty('generated');
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

  it('reads hubs and communities from the graph metadata, cached per graph file but not per WAL write', async () => {
    const env = makeEnv();
    try {
      await indexFixture(env, FIXTURE);
      const uc = new GraphViewUseCase({ store: env.store });
      const ids = withDb(env, (q) => ({
        util: must(q.nodesInFile('src/lib/util.ts').find((n) => n.kind === 'file')).id,
        unused: must(q.nodesInFile('src/lib/util.ts').find((n) => n.name === 'unused')).id,
        index: must(q.nodesInFile('index.ts').find((n) => n.kind === 'file')).id,
        web: must(q.nodesInFile('web/app.js').find((n) => n.kind === 'file')).id,
      }));
      const hubOf = (id: string): boolean | undefined =>
        uc.expand(env.project, ids.util, { visibleIds: [] }).nodes.find((n) => n.id === id)?.hub;
      const webCommunity = (): number | undefined => uc.overview(env.project).nodes.find((n) => n.id === 'dir:web')?.community;
      const indexToWeb = (): number | undefined =>
        uc.overview(env.project).edges.find((e) => e.source === ids.index && e.target === 'dir:web')?.weight;
      const graphFile = env.store.dbPath(env.project);
      // A published graph is in rollback mode: the writer's switch to WAL rewrites the header.
      const writer = openGraphDb(graphFile);
      try {
        const before = fs.statSync(graphFile);
        expect(hubOf(ids.unused)).toBeUndefined();
        expect(webCommunity()).not.toBe(4242);
        expect(indexToWeb()).toBeUndefined();
        const q = new GraphQueries(writer);
        const all = readCommunities(q);
        for (const k of all.keys()) all.set(k, 4242);
        persistCommunities(q, all);
        persistHubs(q, [{ nodeId: ids.unused, degree: 1, score: 1 }]);
        q.insertEdges([{ source: ids.index, target: ids.web, kind: 'imports' }]);
        const after = fs.statSync(graphFile);
        expect({ ino: after.ino, mtimeMs: after.mtimeMs, size: after.size }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs, size: before.size });
        // Only the WAL changed (as after a sync): the overview edges follow it, the hints do not.
        expect(indexToWeb()).toBe(1);
        expect(webCommunity()).not.toBe(4242);
        expect(hubOf(ids.unused)).toBeUndefined();
      } finally {
        writer.close();
      }
      // Closing checkpoints the WAL into graph.db, as a full index replaces the file.
      expect(webCommunity()).toBe(4242);
      expect(hubOf(ids.unused)).toBe(true);
      expect(indexToWeb()).toBe(1);
    } finally {
      env.dispose();
    }
  }, 60_000);

  it('never computes hubs at request time: no persisted hubs means no hub flags', async () => {
    const env = makeEnv();
    try {
      await indexFixture(env, FIXTURE);
      withDb(env, (q) => q.setMeta('hubs', '{corrupt'), false);
      const uc = new GraphViewUseCase({ store: env.store });
      const util = must(uc.expand(env.project, 'dir:src/lib', { visibleIds: [] }).nodes.find((n) => n.label === 'util.ts')).id;
      const symbols = uc.expand(env.project, util, { visibleIds: [] }).nodes;
      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols.some((n) => n.hub === true)).toBe(false);
      const dir = uc.nodeDetail(env.project, 'dir:src');
      if (dir?.kind !== 'dir') throw new Error('expected a dir detail');
      expect(dir.topHubs).toEqual([]);
    } finally {
      env.dispose();
    }
  }, 60_000);

  it('takes a directory\'s top hubs from the persisted ranking, filtered by path prefix', async () => {
    const env = makeEnv();
    try {
      await indexFixture(env, FIXTURE);
      const ranked = withDb(env, (q) => {
        const sym = (file: string, name: string): string => must(q.nodesInFile(file).find((n) => n.name === name), name).id;
        return ['wrap', 'helper', 'run', 'unused', 'greet', 'Greeter'].map((name) =>
          name === 'run' ? sym('src/app/main.ts', name) : sym(name === 'helper' || name === 'unused' ? 'src/lib/util.ts' : 'src/lib/greeter.ts', name),
        );
      });
      const fmt = withDb(env, (q) => must(q.nodesInFile('web/util.js').find((n) => n.name === 'fmt')).id);
      const hubs: Hub[] = [...ranked.slice(0, 2), 'ghost-node', ...ranked.slice(2), fmt].map((nodeId, i) => ({ nodeId, degree: 100 - i, score: 1 }));
      withDb(env, (q) => persistHubs(q, hubs), false);
      const uc = new GraphViewUseCase({ store: env.store });
      const lib = uc.nodeDetail(env.project, 'dir:src/lib');
      if (lib?.kind !== 'dir') throw new Error('expected a dir detail');
      expect(lib.topHubs.map((n) => n.id)).toEqual([ranked[0], ranked[1], ranked[3], ranked[4], ranked[5]]);
      const src = uc.nodeDetail(env.project, 'dir:src');
      if (src?.kind !== 'dir') throw new Error('expected a dir detail');
      expect(src.topHubs.map((n) => n.id)).toEqual(ranked.slice(0, 5));
      const web = uc.nodeDetail(env.project, 'dir:web');
      if (web?.kind !== 'dir') throw new Error('expected a dir detail');
      expect(web.topHubs.map((n) => n.id)).toEqual([fmt]);
      const py = uc.nodeDetail(env.project, 'dir:py');
      if (py?.kind !== 'dir') throw new Error('expected a dir detail');
      expect(py.topHubs).toEqual([]);
    } finally {
      env.dispose();
    }
  }, 60_000);

  it('returns the empty result when graph.db vanishes between the stat and the open', () => {
    const env = makeEnv();
    try {
      seedPlain(env, ['a/x.ts', 'b/y.ts'], (_files, fns) => [{ source: must(fns[0]), target: must(fns[1]), kind: 'calls' }]);
      const file = env.store.dbPath(env.project);
      const backup = `${file}.bak`;
      fs.copyFileSync(file, backup);
      let opens = 0;
      const uc = new GraphViewUseCase({
        store: env.store,
        openDb: (f, o) => {
          opens++;
          fs.rmSync(f, { force: true });
          return openGraphDb(f, o);
        },
      });
      const restore = (): void => fs.copyFileSync(backup, file);
      restore();
      expect(uc.overview(env.project)).toEqual(EMPTY);
      restore();
      expect(uc.expand(env.project, 'dir:a', { visibleIds: [] })).toEqual(EMPTY);
      restore();
      expect(uc.nodeDetail(env.project, 'dir:a')).toBeUndefined();
      restore();
      expect(uc.search(env.project, 'x')).toEqual([]);
      expect(opens).toBe(4);
    } finally {
      env.dispose();
    }
  });

  it('pages the root entries past the first 500 with offset, with edges back to earlier pages', () => {
    const env = makeEnv();
    try {
      const paths = Array.from({ length: 520 }, (_, i) => `d${String(i).padStart(3, '0')}/f.ts`);
      seedPlain(env, paths, (_files, fns) =>
        fns.map((fn, i) => ({ source: fn, target: must(fns[(i + 1) % fns.length]), kind: 'calls' as const })),
      );
      const uc = new GraphViewUseCase({ store: env.store });
      const dir = (i: number): string => `dir:d${String(i).padStart(3, '0')}`;
      const first = uc.overview(env.project);
      expect(first).toMatchObject({ total: 520, hasMore: true });
      expect(first.nodes.map((n) => n.id)).toEqual(Array.from({ length: 500 }, (_, i) => dir(i)));
      expect(asMap(first.edges)).toEqual(new Map(Array.from({ length: 499 }, (_, i) => [`${dir(i)} -> ${dir(i + 1)}`, 1])));
      const second = uc.overview(env.project, { offset: 500 });
      expect(second).toMatchObject({ total: 520, hasMore: false });
      expect(second.nodes.map((n) => n.id)).toEqual(Array.from({ length: 20 }, (_, i) => dir(500 + i)));
      expect(asMap(second.edges)).toEqual(
        new Map([
          ...Array.from({ length: 20 }, (_, i): [string, number] => [`${dir(499 + i)} -> ${dir(500 + i)}`, 1]),
          [`${dir(519)} -> ${dir(0)}`, 1],
        ]),
      );
      expect(uc.overview(env.project, { offset: 520 })).toEqual({ nodes: [], edges: [], total: 520, hasMore: false });
    } finally {
      env.dispose();
    }
  });

  it('caps the edges of a page at GRAPH_EDGE_LIMIT, heaviest first, and flags the cut', () => {
    const env = makeEnv();
    try {
      const n = 80;
      const pad = (i: number): string => String(i).padStart(2, '0');
      const weight = (i: number, j: number): number => 1 + ((i + 2 * j) % 3);
      const paths = [
        ...Array.from({ length: n }, (_, i) => `w/f${pad(i)}.ts`),
        ...Array.from({ length: n }, (_, i) => `r${pad(i)}/f.ts`),
      ];
      seedPlain(env, paths, (_files, fns) => {
        const out: GraphEdge[] = [];
        for (const base of [0, n])
          for (let i = 0; i < n; i++)
            for (let j = 0; j < n; j++)
              for (let k = 0; i !== j && k < weight(i, j); k++)
                out.push({ source: must(fns[base + i]), target: must(fns[base + j]), kind: 'calls', line: k + 1 });
        return out;
      });
      const all = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) all.push(weight(i, j));
      all.sort((a, b) => b - a);
      const threshold = must(all[GRAPH_EDGE_LIMIT - 1]);
      const above = all.filter((w) => w > threshold).length;
      const expectCapped = (page: GraphViewPage): void => {
        expect(page.edgesTruncated).toBe(true);
        expect(page.edges).toHaveLength(GRAPH_EDGE_LIMIT);
        expect(page.edges.every((e) => e.weight >= threshold)).toBe(true);
        expect(page.edges.filter((e) => e.weight > threshold)).toHaveLength(above);
      };
      const uc = new GraphViewUseCase({ store: env.store });
      expectCapped(uc.overview(env.project));
      expectCapped(uc.expand(env.project, 'dir:w', { visibleIds: [] }));
      const small = uc.expand(env.project, 'dir:r00', { visibleIds: ['dir:r01', 'dir:r02'] });
      expect(small.edges.length).toBeGreaterThan(0);
      expect(small).not.toHaveProperty('edgesTruncated');
    } finally {
      env.dispose();
    }
  });
});

/*
 * 50k nodes / 150k edges: pkg0..9/mod0..9 hold 42 files each and `big/` holds 800,
 * 10 nodes per file (file, class + 4 methods, 4 functions). Besides the 45k `contains`
 * edges there is one import per file and 100k calls between uniformly random symbols,
 * the worst case for aggregation (no locality, almost every edge crosses files).
 * `whole` is the same graph moved under a single `all/` directory.
 */
describe('GraphViewUseCase on a 50k-node graph', () => {
  let env: Env;
  let whole: Env;
  let uc: GraphViewUseCase;
  const timings: Record<string, number> = {};
  const COLD_RUNS = 5;

  /** Best time of `op` on a fresh use case (no cached derivatives) per run; only `op` is timed. */
  const coldBest = <T>(target: Env, op: (fresh: GraphViewUseCase) => T): { ms: number; value: T } => {
    let best = Infinity;
    let value: T | undefined;
    for (let i = 0; i < COLD_RUNS; i++) {
      const fresh = new GraphViewUseCase({ store: target.store });
      const start = performance.now();
      value = op(fresh);
      best = Math.min(best, performance.now() - start);
    }
    return { ms: best, value: value as T };
  };

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
      persistHubs(q, findHubs(q, { top: PERSISTED_HUBS }));
      expect(q.counts()).toMatchObject({ nodes: 50_000, edges: 150_000 });
    } finally {
      db.close();
    }
    uc = new GraphViewUseCase({ store: env.store });

    whole = makeEnv();
    fs.mkdirSync(whole.store.dataDir(whole.project), { recursive: true });
    fs.copyFileSync(env.store.dbPath(env.project), whole.store.dbPath(whole.project));
    const w = openGraphDb(whole.store.dbPath(whole.project));
    try {
      const q = new GraphQueries(w);
      // The FTS columns do not include file_path: re-indexing 50k rows would only slow the setup.
      w.exec('DROP TRIGGER nodes_au');
      w.exec("UPDATE nodes SET file_path = 'all/' || file_path");
      w.exec("UPDATE files SET path = 'all/' || path");
      persistCommunities(q, new Map([...readCommunities(q)].map(([p, c]) => [`all/${p}`, c])));
    } finally {
      w.close();
    }
  }, 120_000);

  afterAll(() => {
    const out = process.env['CG_VIEW_PERF_FILE'];
    if (out) fs.writeFileSync(out, JSON.stringify(timings, null, 2));
    env.dispose();
    whole.dispose();
  });

  const overviewIds = (): string[] => uc.overview(env.project).nodes.map((n) => n.id);

  it('overview ≤ 300 ms, cold included', () => {
    const cold = coldBest(env, (fresh) => fresh.overview(env.project));
    timings['overviewCold'] = cold.ms;
    expect(cold.value.edges.length).toBeGreaterThan(0);
    expect(cold.ms).toBeLessThan(perfBudget(300));
    const r = bestOf(() => uc.overview(env.project));
    timings['overview'] = r.ms;
    expect(r.value.nodes.map((n) => n.id)).toEqual(['dir:big', ...Array.from({ length: 10 }, (_, i) => `dir:pkg${i}`)]);
    expect(r.value.edges.length).toBeGreaterThan(0);
    expect(r.ms).toBeLessThan(perfBudget(300));
  }, 60_000);

  it('expand of a directory with 800 children ≤ 200 ms, cold included', () => {
    const visibleIds = overviewIds();
    // ~70 ms alone, but the parallel main suite can starve it for seconds: sample longer.
    const r = bestOf(() => uc.expand(env.project, 'dir:big', { visibleIds }), 20);
    timings['expand800'] = r.ms;
    expect(r.value.nodes).toHaveLength(GRAPH_EXPAND_LIMIT);
    expect(r.value.edges.length).toBeGreaterThan(0);
    expect(r.ms).toBeLessThan(perfBudget(200));
    const cold = coldBest(env, (fresh) => fresh.expand(env.project, 'dir:big', { visibleIds }));
    timings['expand800Cold'] = cold.ms;
    expect(cold.value.nodes).toHaveLength(GRAPH_EXPAND_LIMIT);
    expect(cold.ms).toBeLessThan(perfBudget(200));
  }, 60_000);

  it('expand of a file ≤ 200 ms cold', () => {
    const file = must(uc.expand(env.project, 'dir:big', { visibleIds: [] }).nodes[0]).id;
    const visibleIds = [...overviewIds(), file];
    const cold = coldBest(env, (fresh) => fresh.expand(env.project, file, { visibleIds }));
    timings['expandFileCold'] = cold.ms;
    expect(cold.value.nodes.length).toBeGreaterThan(0);
    expect(cold.ms).toBeLessThan(perfBudget(200));
    timings['expandFile'] = bestOf(() => uc.expand(env.project, file, { visibleIds })).ms;
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

  it('nodeDetail ≤ 300 ms, cold included', () => {
    const sample = uc.expand(env.project, must(uc.expand(env.project, 'dir:big', { visibleIds: [] }).nodes[0]).id, { visibleIds: [] }).nodes;
    const target = must(sample.find((n) => n.kind === 'function')).id;
    const cold = coldBest(env, (fresh) => fresh.nodeDetail(env.project, target));
    timings['nodeDetailSymbolCold'] = cold.ms;
    expect(cold.value?.kind).toBe('symbol');
    expect(cold.ms).toBeLessThan(perfBudget(300));
    const r = bestOf(() => uc.nodeDetail(env.project, target));
    timings['nodeDetailSymbol'] = r.ms;
    expect(r.value?.kind).toBe('symbol');
    expect(r.ms).toBeLessThan(perfBudget(300));
    const dir = bestOf(() => uc.nodeDetail(env.project, 'dir:pkg0'));
    timings['nodeDetailDir'] = dir.ms;
    expect(dir.value?.kind).toBe('dir');
    expect(dir.ms).toBeLessThan(perfBudget(300));
  }, 60_000);

  it('nodeDetail of a directory holding the whole graph ≤ 300 ms cold', () => {
    const cold = coldBest(whole, (fresh) => fresh.nodeDetail(whole.project, 'dir:all'));
    timings['nodeDetailWholeDirCold'] = cold.ms;
    const d = cold.value;
    if (d?.kind !== 'dir') throw new Error('expected a dir detail');
    expect(d).toMatchObject({ fileCount: 5000, symbolCount: 45_000 });
    expect(d.topHubs).toHaveLength(5);
    expect(d.topHubs.every((n) => n.filePath.startsWith('all/'))).toBe(true);
    expect(cold.ms).toBeLessThan(perfBudget(300));
    const warm = new GraphViewUseCase({ store: whole.store });
    timings['nodeDetailWholeDir'] = bestOf(() => warm.nodeDetail(whole.project, 'dir:all')).ms;
  }, 60_000);

  it('search ≤ 300 ms and at most 50 merged results, cold included', () => {
    const cold = coldBest(env, (fresh) => fresh.search(env.project, 'fn1'));
    timings['searchCold'] = cold.ms;
    expect(cold.value.length).toBeGreaterThan(0);
    expect(cold.ms).toBeLessThan(perfBudget(300));
    const r = bestOf(() => uc.search(env.project, 'fn1'));
    timings['search'] = r.ms;
    expect(r.value.length).toBeGreaterThan(0);
    expect(r.value.length).toBeLessThanOrEqual(50);
    const mixed = uc.search(env.project, 'b00');
    expect(mixed.some((x) => x.node.kind === 'file')).toBe(true);
    expect(mixed.length).toBeLessThanOrEqual(50);
    expect(r.ms).toBeLessThan(perfBudget(300));
  }, 60_000);
});
