import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openGraphDb } from '../db/connection';
import { GraphQueries } from '../db/queries';
import { discoverFiles, toProjectPath } from '../discovery/discover';
import { isSupported } from './extract-file';
import { GRAPH_DB_FILE, indexProject, type IndexResult } from './orchestrator';
import { syncProject } from './sync';
import { TestProject } from './sync-test-support';

// Creating symlinks on Windows needs admin rights or developer mode: the symlink cases run on POSIX only.
const isWindows = process.platform === 'win32';
// chmod 000 does not stop root (CI containers often run as root), and Windows has no POSIX modes.
const canRevokeRead = !isWindows && process.getuid?.() !== 0;

let project: TestProject;
let dataDir: string;

beforeEach(() => {
  project = new TestProject();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hostile-data-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const rel of ['locked', 'src/locked']) {
    if (project.exists(rel)) fs.chmodSync(project.abs(rel), 0o755);
  }
  project.dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function graph<T>(fn: (q: GraphQueries) => T): T {
  const db = openGraphDb(path.join(dataDir, GRAPH_DB_FILE), { readonly: true });
  try {
    return fn(new GraphQueries(db));
  } finally {
    db.close();
  }
}

const indexed = (): string[] => graph((q) => q.fileRecords().map((r) => r.path)).sort();
const skippedBy = (r: IndexResult, reason: string): string[] =>
  r.skippedFiles.filter((s) => s.reason === reason).map((s) => s.path).sort();

describe('indexProject on hostile trees', () => {
  it('indexes the rest and explains every skipped file: 5 MB file, minified bundle, symlink cycle, unreadable folder', async () => {
    project.write('src/ok.ts', 'export function ok(): number {\n  return 1;\n}\n');
    project.write('src/huge.ts', `export const big = 1;\n${'// filler line to reach five megabytes\n'.repeat(130_000)}`);
    expect(fs.statSync(project.abs('src/huge.ts')).size).toBeGreaterThan(5_000_000);
    project.write('src/bundle.js', `var a=1;${'function f(n){return n+1}'.repeat(8000)}`);
    if (!isWindows) {
      fs.symlinkSync(project.root, project.abs('src/loop'), 'dir');
      fs.symlinkSync('../src', project.abs('src/again'), 'dir');
    }
    if (canRevokeRead) {
      project.write('locked/secret.ts', 'export const secret = 1;\n');
      fs.chmodSync(project.abs('locked'), 0o000);
    }

    const r = await indexProject({ root: project.root, dataDir });

    expect(indexed()).toEqual(['src/ok.ts']);
    expect(r.files).toBe(1);
    expect(skippedBy(r, 'too-large')).toEqual(['src/huge.ts']);
    expect(skippedBy(r, 'minified')).toEqual(['src/bundle.js']);
    if (!isWindows) expect(skippedBy(r, 'symlink')).toEqual(['src/again', 'src/loop']);
    if (canRevokeRead) expect(skippedBy(r, 'unreadable')).toEqual(['locked']);
    expect(r.skipped).toBe(r.skippedFiles.length);
    expect(fs.readdirSync(dataDir).filter((n) => n.includes('building'))).toEqual([]);
  }, 60_000);

  it('indexes a file with invalid UTF-8 bytes and a file named with an emoji', async () => {
    project.write('src/😀 smile.ts', 'export function smile(): string {\n  return "😀";\n}\n');
    const bad = Buffer.concat([
      Buffer.from('export function broken(): number {\n  return 1;\n}\n// '),
      Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xa0, 0xa1, 0xf0, 0x28, 0x8c, 0xbc]),
      Buffer.from('\nexport function after(): number {\n  return 2;\n}\n'),
    ]);
    fs.writeFileSync(project.abs('src/bad.ts'), bad);

    const r = await indexProject({ root: project.root, dataDir });

    expect(r.skippedFiles).toEqual([]);
    expect(indexed()).toEqual(['src/bad.ts', 'src/😀 smile.ts']);
    const names = graph((q) => q.nodeRefsInFiles(['src/bad.ts', 'src/😀 smile.ts']).map((n) => n.name)).sort();
    expect(names).toEqual(expect.arrayContaining(['after', 'broken', 'smile']));
  }, 30_000);

  it('indexes a project without .git', async () => {
    project.write('a.py', 'def run():\n    return 1\n');
    expect(project.exists('.git')).toBe(false);
    const r = await indexProject({ root: project.root, dataDir });
    expect(r.files).toBe(1);
    expect(indexed()).toEqual(['a.py']);
  }, 30_000);

  it('publishes an empty graph for an empty project, and syncs it without errors', async () => {
    const r = await indexProject({ root: project.root, dataDir });
    expect(r).toMatchObject({ files: 0, nodes: 0, edges: 0, skipped: 0, skippedFiles: [], languages: {} });
    expect(fs.readdirSync(dataDir).sort()).toEqual([GRAPH_DB_FILE]);
    expect(graph((q) => q.counts())).toMatchObject({ files: 0, nodes: 0, edges: 0 });
    await expect(syncProject({ root: project.root, dataDir })).resolves.toMatchObject({
      added: 0,
      modified: 0,
      deleted: 0,
      fullIndexRequired: false,
    });
  }, 30_000);
});

describe('syncProject on hostile changes', () => {
  it('does not report a new file it cannot read as added, sync after sync', async () => {
    project.write('src/a.ts', 'export function a(): number {\n  return 1;\n}\n');
    await indexProject({ root: project.root, dataDir });
    project.write('src/flaky.ts', 'export function flaky(): number {\n  return 2;\n}\n');
    const realRead = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith('flaky.ts')) return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      return (realRead as (...a: unknown[]) => Promise<Buffer>)(p, ...rest);
    }) as typeof fs.promises.readFile);

    for (let i = 0; i < 2; i++) {
      const r = await syncProject({ root: project.root, dataDir });
      expect(r).toMatchObject({ added: 0, modified: 0, deleted: 0, truncated: false });
    }
    expect(indexed()).toEqual(['src/a.ts']);

    spy.mockRestore();
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ added: 1 });
    expect(indexed()).toEqual(['src/a.ts', 'src/flaky.ts']);
  }, 30_000);

  it.skipIf(!canRevokeRead)('drops the files of a folder that became unreadable and stays quiet afterwards', async () => {
    project.write('src/a.ts', 'export function a(): number {\n  return 1;\n}\n');
    project.write('src/locked/b.ts', 'export function b(): number {\n  return 2;\n}\n');
    await indexProject({ root: project.root, dataDir });
    fs.chmodSync(project.abs('src/locked'), 0o000);
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ deleted: 1 });
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ added: 0, modified: 0, deleted: 0 });
    expect(indexed()).toEqual(['src/a.ts']);
  }, 30_000);
});

describe('Windows paths', () => {
  it('normalises backslash paths to the stored `/` form', () => {
    const root = 'C:\\work\\app';
    expect(toProjectPath(root, 'src\\deep\\a.ts', path.win32)).toBe('src/deep/a.ts');
    expect(toProjectPath(root, 'C:\\work\\app\\src\\b.ts', path.win32)).toBe('src/b.ts');
    expect(toProjectPath(root, 'C:/work/app/src/c.ts', path.win32)).toBe('src/c.ts');
    expect(toProjectPath('C:/work/app', 'src\\d.ts', path.win32)).toBe('src/d.ts');
    expect(toProjectPath(root, '..\\other\\x.ts', path.win32)).toBeUndefined();
    expect(toProjectPath(root, 'D:\\elsewhere\\x.ts', path.win32)).toBeUndefined();
  });

  it('discoverFiles never yields a backslash in a stored path', async () => {
    project.write('src/deep/nested/a.ts', 'export const a = 1;\n');
    project.write('lib/b.py', 'x = 1\n');
    const r = await discoverFiles(project.root, { isSupported });
    expect(r.files.map((f) => f.relPath).sort()).toEqual(['lib/b.py', 'src/deep/nested/a.ts']);
    for (const f of r.files) expect(f.relPath).not.toContain('\\');
  });
});
