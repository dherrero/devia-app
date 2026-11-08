import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openGraphDb } from '../db/connection';
import { GraphQueries } from '../db/queries';
import { acquireWriterLock, readWriterLock } from '../db/writer-lock';
import { discoverFiles } from '../discovery/discover';
import { persistCommunities, persistHubs, readCommunities, readHubs } from '../graph/communities';
import { detectChanges } from './change-detection';
import { isSupported } from './extract-file';
import { EXTRACTION_VERSION, GRAPH_DB_FILE } from './orchestrator';
import { syncProject } from './sync';
import { fullIndex, fullIndexSnapshot, snapshotGraph, TestProject } from './sync-test-support';

let project: TestProject;
let dataDir: string;

beforeEach(() => {
  project = new TestProject();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-data-'));
});

afterEach(() => {
  project.dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const A_TS = "import { b } from './b';\nexport function a(): number {\n  return b();\n}\n";
const B_TS = 'export function b(): number {\n  return 1;\n}\n';

function withDb<T>(fn: (q: GraphQueries) => T): T {
  const db = openGraphDb(path.join(dataDir, GRAPH_DB_FILE), { readonly: true });
  try {
    return fn(new GraphQueries(db));
  } finally {
    db.close();
  }
}

function sym(file: string, kind: 'function' | 'class' | 'method', name: string): string | undefined {
  return withDb((q) => q.nodesInFile(file).find((n) => n.kind === kind && n.name === name))?.id;
}

function callTargets(sourceId: string | undefined): string[] {
  if (sourceId === undefined) return [];
  return withDb((q) => q.edgesFrom(sourceId, ['calls']).map((e) => e.target));
}

function filesInDb(): string[] {
  return withDb((q) => q.filePaths()).sort();
}

/** Edges whose endpoints are missing would mean a caller hangs on a deleted symbol. */
function danglingCount(): number {
  return withDb((q) => {
    const ids = new Set(q.nodeSummaries().map((n) => n.id));
    return q
      .edgesOfKinds(['contains', 'calls', 'imports', 'exports', 'extends', 'implements', 'references', 'type_of', 'returns', 'instantiates', 'overrides', 'decorates'])
      .filter((e) => !ids.has(e.source) || !ids.has(e.target)).length;
  });
}

async function expectParity(): Promise<void> {
  expect(snapshotGraph(dataDir)).toEqual(await fullIndexSnapshot(project.root));
}

async function indexed(files: Record<string, string>): Promise<void> {
  project.writeAll(files);
  await fullIndex(project.root, dataDir);
}

describe('detectChanges', () => {
  it('reports added, modified and deleted files and leaves an mtime-only change as touched', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS, 'c.ts': 'export const c = 1;\n' });
    project.write('a.ts', A_TS.replace('b()', 'b() + 1'));
    project.touch('b.ts');
    project.remove('c.ts');
    project.write('d.ts', 'export const d = 1;\n');
    const discovered = await discoverFiles(project.root, { isSupported });
    const db = openGraphDb(path.join(dataDir, GRAPH_DB_FILE));
    try {
      const changes = detectChanges(new GraphQueries(db), discovered.files);
      expect(changes.added).toEqual(['d.ts']);
      expect(changes.modified).toEqual(['a.ts']);
      expect(changes.deleted).toEqual(['c.ts']);
      expect(changes.touched.map((t) => t.path)).toEqual(['b.ts']);
    } finally {
      db.close();
    }
  });
});

describe('syncProject', () => {
  it('adds the nodes of a new file', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    project.write('c.ts', 'export function c(): number {\n  return 3;\n}\n');
    const result = await syncProject({ root: project.root, dataDir });
    expect(result).toEqual({ added: 1, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false });
    expect(sym('c.ts', 'function', 'c')).toBeDefined();
    await expectParity();
  });

  it('replaces the nodes of a modified file', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    project.write('b.ts', 'export function b2(): number {\n  return 2;\n}\n');
    const result = await syncProject({ root: project.root, dataDir });
    expect(result.modified).toBe(1);
    expect(sym('b.ts', 'function', 'b')).toBeUndefined();
    expect(sym('b.ts', 'function', 'b2')).toBeDefined();
    expect(callTargets(sym('a.ts', 'function', 'a'))).toEqual([]);
    await expectParity();
  });

  it('does not re-extract a file whose mtime changed but content did not', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    const before = withDb((q) => q.fileRecords().find((f) => f.path === 'b.ts'));
    project.touch('b.ts');
    const result = await syncProject({ root: project.root, dataDir });
    expect(result).toMatchObject({ added: 0, modified: 0, deleted: 0 });
    const after = withDb((q) => q.fileRecords().find((f) => f.path === 'b.ts'));
    expect(after?.indexedAt).toBe(before?.indexedAt);
    expect(after?.modifiedAt).toBe(Math.round(fs.statSync(project.abs('b.ts')).mtimeMs));
    expect(after?.modifiedAt).not.toBe(before?.modifiedAt);
    await expectParity();
  });

  it('drops the a→b call when b.ts is deleted and restores it when b.ts comes back', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    const b = sym('b.ts', 'function', 'b');
    expect(callTargets(sym('a.ts', 'function', 'a'))).toEqual([b]);

    project.remove('b.ts');
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ deleted: 1 });
    expect(filesInDb()).toEqual(['a.ts']);
    expect(callTargets(sym('a.ts', 'function', 'a'))).toEqual([]);
    expect(danglingCount()).toBe(0);
    await expectParity();

    project.write('b.ts', B_TS);
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ added: 1 });
    expect(callTargets(sym('a.ts', 'function', 'a'))).toEqual([b]);
    await expectParity();
  });

  it('treats a rename as delete + add and re-resolves the callers against the new file', async () => {
    await indexed({
      'pkg/util.py': 'def helper():\n    return 1\n',
      'pkg/main.py': 'def run():\n    return helper()\n',
      'a.ts': A_TS,
      'b.ts': B_TS,
    });
    expect(callTargets(sym('pkg/main.py', 'function', 'run'))).toEqual([sym('pkg/util.py', 'function', 'helper')]);

    project.rename('pkg/util.py', 'pkg/tools.py');
    project.rename('b.ts', 'c.ts');
    project.write('a.ts', A_TS.replace("'./b'", "'./c'"));
    const result = await syncProject({ root: project.root, dataDir });
    expect(result).toMatchObject({ added: 2, modified: 1, deleted: 2 });
    expect(callTargets(sym('pkg/main.py', 'function', 'run'))).toEqual([sym('pkg/tools.py', 'function', 'helper')]);
    expect(callTargets(sym('a.ts', 'function', 'a'))).toEqual([sym('c.ts', 'function', 'b')]);
    expect(danglingCount()).toBe(0);
    await expectParity();
  });

  it('re-resolves importers of a neighbour when a new file takes over its import path', async () => {
    await indexed({
      'side/index.ts': 'export const s = 1;\n',
      'uses.ts': "import './side';\nexport const u = 1;\n",
    });
    project.write('side.ts', 'export const t = 2;\n');
    await syncProject({ root: project.root, dataDir });
    await expectParity();
  });

  it('keeps a consistent graph when a file is saved with a syntax error', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    project.write('b.ts', 'export function b(): number {\n  return 1;\n}\nexport function broken( {\n');
    await syncProject({ root: project.root, dataDir });
    expect(danglingCount()).toBe(0);
    expect(withDb((q) => q.fileRecords().find((f) => f.path === 'b.ts')?.errors?.length ?? 0)).toBeGreaterThan(0);
    await expectParity();
    project.write('b.ts', B_TS);
    await syncProject({ root: project.root, dataDir });
    expect(callTargets(sym('a.ts', 'function', 'a'))).toEqual([sym('b.ts', 'function', 'b')]);
    await expectParity();
  });

  it('ignores unsupported and ignored files', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS, '.gitignore': 'secret/\n' });
    project.write('README.md', '# hi\n');
    project.write('node_modules/lib/index.ts', 'export const x = 1;\n');
    project.write('secret/key.ts', 'export const k = 1;\n');
    project.write('dist/out.js', 'export const o = 1;\n');
    const result = await syncProject({ root: project.root, dataDir });
    expect(result).toMatchObject({ added: 0, modified: 0, deleted: 0 });
    expect(filesInDb()).toEqual(['a.ts', 'b.ts']);
  });

  it.skipIf(process.platform === 'win32')('never follows symlinks', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'x.ts'), 'export const x = 1;\n');
      await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
      fs.symlinkSync(path.join(outside, 'x.ts'), project.abs('link.ts'));
      fs.symlinkSync(outside, project.abs('linkdir'));
      fs.symlinkSync(project.root, project.abs('loop'));
      const result = await syncProject({ root: project.root, dataDir });
      expect(result).toMatchObject({ added: 0 });
      const only = await syncProject({ root: project.root, dataDir, onlyPaths: ['link.ts', 'linkdir/x.ts', 'loop/a.ts'] });
      expect(only).toMatchObject({ added: 0, deleted: 0 });
      expect(filesInDb()).toEqual(['a.ts', 'b.ts']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('handles a file replaced by a directory or by a symlink', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS, 'c.ts': 'export const c = 1;\n' });
    project.remove('b.ts');
    project.write('b.ts/index.ts', 'export function b(): number {\n  return 5;\n}\n');
    if (process.platform !== 'win32') {
      project.remove('c.ts');
      fs.symlinkSync(project.abs('a.ts'), project.abs('c.ts'));
    }
    await syncProject({ root: project.root, dataDir });
    expect(filesInDb()).toEqual(process.platform === 'win32' ? ['a.ts', 'b.ts/index.ts', 'c.ts'] : ['a.ts', 'b.ts/index.ts']);
    expect(danglingCount()).toBe(0);
    await expectParity();
  });

  it('skips without touching anything while a full index holds the lock', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    project.write('b.ts', 'export function z(): number {\n  return 9;\n}\n');
    const before = snapshotGraph(dataDir);
    const lock = acquireWriterLock(dataDir, 'indexer');
    expect(lock).not.toBeNull();
    try {
      const result = await syncProject({ root: project.root, dataDir });
      expect(result).toEqual({ added: 0, modified: 0, deleted: 0, skippedBusy: true, truncated: false, fullIndexRequired: false });
      expect(snapshotGraph(dataDir)).toEqual(before);
    } finally {
      lock?.release();
    }
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ modified: 1, skippedBusy: false });
    await expectParity();
  });

  it('lets only one of two concurrent syncs run', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    project.write('c.ts', 'export const c = 1;\n');
    const results = await Promise.all([
      syncProject({ root: project.root, dataDir }),
      syncProject({ root: project.root, dataDir }),
    ]);
    expect(results.map((r) => r.skippedBusy).sort()).toEqual([false, true]);
    expect(results.find((r) => !r.skippedBusy)?.added).toBe(1);
    await expectParity();
  });

  it('with deadlineMs 0 still applies the first changed file, reports truncated, then catches up', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    project.write('b.ts', 'export function z(): number {\n  return 9;\n}\n');
    project.write('c.ts', 'export const c = 1;\n');
    const first = await syncProject({ root: project.root, dataDir, deadlineMs: 0 });
    expect(first).toEqual({ added: 0, modified: 1, deleted: 0, skippedBusy: false, truncated: true, fullIndexRequired: false });
    expect(sym('b.ts', 'function', 'z')).toBeDefined();
    expect(filesInDb()).toEqual(['a.ts', 'b.ts']);
    expect(await syncProject({ root: project.root, dataDir, deadlineMs: 0 })).toMatchObject({ added: 1, truncated: false });
    await expectParity();
  });

  it('with deadlineMs 0 on a clean tree reports nothing to do, not truncated', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    expect(await syncProject({ root: project.root, dataDir, deadlineMs: 0 })).toEqual({
      added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false,
    });
  });

  it('applies exactly one changed file (with its closure) per call under a zero deadline', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      files[`m${i}/index.ts`] = `export function f${i}(): number {\n  return ${i};\n}\n`;
      files[`u${i}.ts`] = `import { f${i} } from './m${i}';\nexport const u${i} = f${i}();\n`;
    }
    await indexed(files);
    for (const i of [0, 7, 13]) project.write(`m${i}/index.ts`, `export function f${i}(): number {\n  return ${i + 100};\n}\n`);
    const results = [];
    for (let call = 0; call < 3; call++) results.push(await syncProject({ root: project.root, dataDir, deadlineMs: 0 }));
    expect(results.map((r) => [r.modified, r.truncated])).toEqual([[1, true], [1, true], [1, false]]);
    await expectParity();
  });

  it('re-extracts only the edited file and its own importers when many files share its stem', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      files[`m${i}/index.ts`] = `export function f${i}(): number {\n  return ${i};\n}\n`;
      files[`u${i}.ts`] = `import { f${i} } from './m${i}';\nexport const u${i} = f${i}();\n`;
    }
    await indexed(files);
    project.write('m0/index.ts', 'export function f0(): number {\n  return 100;\n}\n');
    const read = vi.spyOn(fs.promises, 'readFile');
    try {
      expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ modified: 1, truncated: false });
      const extracted = read.mock.calls.map(([p]) => path.relative(project.root, String(p)).split(path.sep).join('/'));
      expect(extracted.sort()).toEqual(['m0/index.ts', 'u0.ts']);
    } finally {
      read.mockRestore();
    }
    await expectParity();
  });

  it('treats a modified file that cannot be read at extraction time as deleted, importers included', async () => {
    await indexed({ 'x/index.ts': 'export function g(): number {\n  return 1;\n}\n', 'use.ts': "import './x';\nexport const u = 1;\n" });
    project.write('x/index.ts', 'export function g(): number {\n  return 2;\n}\n');
    const original = fs.promises.readFile.bind(fs.promises);
    const read = vi.spyOn(fs.promises, 'readFile').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith(`x${path.sep}index.ts`)) {
        fs.rmSync(project.abs('x'), { recursive: true, force: true });
        return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      }
      return (original as (...a: unknown[]) => Promise<Buffer>)(p, ...rest);
    }) as typeof fs.promises.readFile);
    try {
      expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ modified: 0, deleted: 1 });
    } finally {
      read.mockRestore();
    }
    expect(filesInDb()).toEqual(['use.ts']);
    await expectParity();
  });

  it('caps the changed files per call with maxFiles and converges on later calls', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    project.remove('b.ts');
    project.write('c.ts', 'export const c = 1;\n');
    project.write('d.ts', 'export const d = 1;\n');
    const first = await syncProject({ root: project.root, dataDir, maxFiles: 1 });
    expect(first.truncated).toBe(true);
    expect(first.added + first.modified + first.deleted).toBe(1);
    let rounds = 0;
    while ((await syncProject({ root: project.root, dataDir, maxFiles: 1 })).truncated) rounds++;
    expect(rounds).toBeLessThanOrEqual(2);
    await expectParity();
  });

  it('with onlyPaths syncs just those paths', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS, 'c.ts': 'export const c = 1;\n' });
    project.write('b.ts', 'export function b(): number {\n  return 2;\n}\nexport const extra = 1;\n');
    project.remove('c.ts');
    project.write('d.ts', 'export const d = 1;\n');
    project.write('node_modules/e.ts', 'export const e = 1;\n');
    const result = await syncProject({
      root: project.root,
      dataDir,
      onlyPaths: ['b.ts', path.join(project.root, 'd.ts'), 'node_modules/e.ts', '../outside.ts'],
    });
    expect(result).toMatchObject({ added: 1, modified: 1, deleted: 0 });
    expect(filesInDb()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    expect(callTargets(sym('a.ts', 'function', 'a'))).toEqual([sym('b.ts', 'function', 'b')]);
    expect(await syncProject({ root: project.root, dataDir, onlyPaths: ['c.ts'] })).toMatchObject({ deleted: 1 });
    await expectParity();
  });

  it('with onlyPaths matches the indexed spelling case-insensitively and skips directories', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS, 'sub/c.ts': 'export const c = 1;\n' });
    project.write('b.ts', 'export function b(): number {\n  return 2;\n}\n');
    project.write('sub/c.ts', 'export const c = 2;\n');
    expect(await syncProject({ root: project.root, dataDir, onlyPaths: ['sub'] })).toMatchObject({ added: 0, modified: 0, deleted: 0 });
    expect(await syncProject({ root: project.root, dataDir, onlyPaths: ['B.TS'] })).toMatchObject({ added: 0, modified: 1, deleted: 0 });
    expect(filesInDb()).toEqual(['a.ts', 'b.ts', 'sub/c.ts']);
    expect(await syncProject({ root: project.root, dataDir, onlyPaths: ['SUB/C.ts'] })).toMatchObject({ modified: 1 });
    await expectParity();
  });

  it('rolls back to the previous graph and releases the lock when the write phase throws', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    project.write('b.ts', 'export function z(): number {\n  return 9;\n}\n');
    project.write('c.ts', 'export const c = 1;\n');
    const before = snapshotGraph(dataDir);
    const spy = vi.spyOn(GraphQueries.prototype, 'languageCounts').mockImplementationOnce(() => {
      throw new Error('injected failure');
    });
    try {
      await expect(syncProject({ root: project.root, dataDir })).rejects.toThrow('injected failure');
    } finally {
      spy.mockRestore();
    }
    expect(snapshotGraph(dataDir)).toEqual(before);
    expect(readWriterLock(dataDir)).toBeNull();
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ added: 1, modified: 1 });
    await expectParity();
  });

  it('asks for a full index instead of syncing when a resolution config changed', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS, 'tsconfig.json': '{}\n', 'go.mod': 'module example.com/m\n' });
    project.write('b.ts', 'export function z(): number {\n  return 9;\n}\n');
    const before = snapshotGraph(dataDir);
    const required = { added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: true };

    project.write('tsconfig.json', '{ "compilerOptions": { "baseUrl": "." } }\n');
    expect(await syncProject({ root: project.root, dataDir })).toEqual(required);
    expect(await syncProject({ root: project.root, dataDir, onlyPaths: ['b.ts'] })).toEqual(required);
    expect(snapshotGraph(dataDir)).toEqual(before);
    project.write('tsconfig.json', '{}\n');

    project.remove('go.mod');
    expect(await syncProject({ root: project.root, dataDir })).toEqual(required);
    project.write('go.mod', 'module example.com/m\n');

    project.write('app/pubspec.yaml', 'name: app\n');
    expect(await syncProject({ root: project.root, dataDir })).toEqual(required);
    project.remove('app');

    project.write('node_modules/x/tsconfig.json', '{ "x": 1 }\n');
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ modified: 1, fullIndexRequired: false });
    await expectParity();
  });

  it('asks for a full index when a tsconfig reached through extends or references changes, and only then', async () => {
    await indexed({
      'a.ts': A_TS,
      'b.ts': B_TS,
      'tsconfig.json': '{ "extends": "./tsconfig.base.json", "references": [{ "path": "./tsconfig.app.json" }, { "path": "./pkg" }] }\n',
      'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@b": ["b.ts"] } } }\n',
      'tsconfig.app.json': '{ "extends": "./configs/shared" }\n',
      'configs/shared.json': '{}\n',
      'pkg/tsconfig.json': '{}\n',
      'data.json': '{ "x": 1 }\n',
    });
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ fullIndexRequired: false });
    project.write('b.ts', 'export function z(): number {\n  return 9;\n}\n');
    const before = snapshotGraph(dataDir);
    const required = { added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: true };
    const restore = (rel: string): (() => void) => {
      const text = project.read(rel);
      return () => project.write(rel, text);
    };
    for (const rel of ['tsconfig.base.json', 'tsconfig.app.json', 'configs/shared.json', 'pkg/tsconfig.json']) {
      const undo = restore(rel);
      project.write(rel, '{ "compilerOptions": { "baseUrl": "src" } }\n');
      expect(await syncProject({ root: project.root, dataDir }), rel).toEqual(required);
      expect(await syncProject({ root: project.root, dataDir, onlyPaths: ['b.ts'] }), rel).toEqual(required);
      expect(snapshotGraph(dataDir), rel).toEqual(before);
      undo();
    }
    project.write('data.json', '{ "x": 2 }\n');
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ modified: 1, fullIndexRequired: false });
    await expectParity();
  });

  it.skipIf(process.platform === 'win32')('tracks a symlinked tsconfig the loader follows', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-cfg-'));
    try {
      fs.writeFileSync(path.join(outside, 'tsconfig.json'), '{}\n');
      project.writeAll({ 'a.ts': A_TS, 'b.ts': B_TS });
      fs.symlinkSync(path.join(outside, 'tsconfig.json'), project.abs('tsconfig.json'));
      await fullIndex(project.root, dataDir);
      expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ fullIndexRequired: false });
      fs.writeFileSync(path.join(outside, 'tsconfig.json'), '{ "compilerOptions": { "baseUrl": "." } }\n');
      expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ fullIndexRequired: true });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('asks for a full index when the graph was built by another extraction version or root', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    const setMeta = (key: string, value: string): void => {
      const rw = openGraphDb(path.join(dataDir, GRAPH_DB_FILE));
      try {
        new GraphQueries(rw).setMeta(key, value);
      } finally {
        rw.close();
      }
    };
    const root = withDb((q) => q.getMeta('root') ?? '');
    setMeta('extraction_version', '0');
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ fullIndexRequired: true });
    setMeta('extraction_version', String(EXTRACTION_VERSION));
    setMeta('root', '/somewhere/else');
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ fullIndexRequired: true });
    setMeta('root', root);
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ fullIndexRequired: false });
  });

  it('keeps the community and hub metadata and refreshes indexed_at and languages', async () => {
    await indexed({ 'a.ts': A_TS, 'b.ts': B_TS });
    const rw = openGraphDb(path.join(dataDir, GRAPH_DB_FILE));
    try {
      const q = new GraphQueries(rw);
      persistCommunities(q, new Map([['a.ts', 7]]));
      persistHubs(q, [{ nodeId: 'stale-hint', degree: 9, score: 1 }]);
      q.setMeta('indexed_at', '1');
    } finally {
      rw.close();
    }
    project.write('p.py', 'def f():\n    return 1\n');
    await syncProject({ root: project.root, dataDir });
    withDb((q) => {
      expect(readCommunities(q).get('a.ts')).toBe(7);
      expect(readHubs(q)).toEqual([{ nodeId: 'stale-hint', degree: 9, score: 1 }]);
      expect(Number(q.getMeta('indexed_at'))).toBeGreaterThan(1);
      expect(JSON.parse(q.getMeta('languages') ?? '{}')).toEqual({ typescript: 2, python: 1 });
    });
  });

  it('syncs an empty project without changes', async () => {
    await fullIndex(project.root, dataDir);
    const result = await syncProject({ root: project.root, dataDir });
    expect(result).toEqual({ added: 0, modified: 0, deleted: 0, skippedBusy: false, truncated: false, fullIndexRequired: false });
    await expectParity();
  });

  it('fails with GRAPH_NOT_FOUND when the project has no graph yet', async () => {
    project.write('a.ts', A_TS);
    await expect(syncProject({ root: project.root, dataDir })).rejects.toMatchObject({ code: 'GRAPH_NOT_FOUND' });
    await expect(
      syncProject({ root: project.root, dataDir: path.join(dataDir, 'missing') }),
    ).rejects.toMatchObject({ code: 'GRAPH_NOT_FOUND' });
    expect(fs.existsSync(path.join(dataDir, GRAPH_DB_FILE))).toBe(false);
  });
});
