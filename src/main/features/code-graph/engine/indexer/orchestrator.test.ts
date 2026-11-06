import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IndexProgress } from '../../../../../shared/domain/code-graph';
import { openGraphDb } from '../db/connection';
import { GraphQueries } from '../db/queries';
import { contentHash } from './hash';
import { EXTRACTION_VERSION, indexProject } from './orchestrator';

let root: string;
let dataDir: string;

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writeThreeFiles(): void {
  write('src/a.ts', "import { b } from './b';\nexport function a(): number {\n  return b();\n}\n");
  write('src/b.ts', "import { c } from './c';\nexport function b(): number {\n  return c() + 1;\n}\n");
  write('src/c.ts', 'export function c(): number {\n  return 1;\n}\n');
}

function dataFiles(): string[] {
  return fs.readdirSync(dataDir).sort();
}

interface FileDbRow {
  path: string;
  errors: string | null;
  generated: number;
  is_test: number;
  content_hash: string;
}

function readFiles(): FileDbRow[] {
  const db = openGraphDb(path.join(dataDir, 'graph.db'), { readonly: true });
  try {
    return db
      .prepare('SELECT path, errors, generated, is_test, content_hash FROM files ORDER BY path')
      .all() as unknown as FileDbRow[];
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-index-root-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-index-data-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('contentHash', () => {
  it('is the sha1 hex digest of the bytes', () => {
    expect(contentHash(Buffer.from('abc'))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
});

describe('indexProject', () => {
  it('indexes a small project and reports phases in order', async () => {
    writeThreeFiles();
    const progress: IndexProgress[] = [];
    const result = await indexProject({ root, dataDir, onProgress: (p) => progress.push(p) });

    expect(result.files).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.languages).toEqual({ typescript: 3 });
    expect(result.nodes).toBeGreaterThanOrEqual(6);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const phases = progress.map((p) => p.phase).filter((p, i, all) => i === 0 || all[i - 1] !== p);
    expect(phases).toEqual(['discover', 'parse', 'resolve', 'finalize']);
    const lastParse = progress.filter((p) => p.phase === 'parse').at(-1);
    expect(lastParse).toMatchObject({ filesDone: 3, filesTotal: 3 });

    expect(dataFiles()).toEqual(['graph.db']);
    const db = openGraphDb(path.join(dataDir, 'graph.db'), { readonly: true });
    try {
      const q = new GraphQueries(db);
      expect(q.counts()).toEqual({ nodes: result.nodes, edges: result.edges, files: 3 });
      expect(q.nodesByName('b', 10).map((n) => n.filePath)).toContain('src/b.ts');
      expect(q.getMeta('extraction_version')).toBe(String(EXTRACTION_VERSION));
      expect(q.getMeta('root')).toBe(root);
      expect(Number(q.getMeta('indexed_at'))).toBeGreaterThan(0);
      expect(JSON.parse(q.getMeta('languages') ?? '{}')).toEqual({ typescript: 3 });
    } finally {
      db.close();
    }
    const c = readFiles().find((f) => f.path === 'src/c.ts');
    expect(c?.content_hash).toBe(contentHash(fs.readFileSync(path.join(root, 'src/c.ts'))));
  });

  it('runs the resolve hook on the building DB before the swap', async () => {
    writeThreeFiles();
    let seen: { graphExists: boolean; buildingExists: boolean; files: number } | undefined;
    await indexProject({
      root,
      dataDir,
      resolve: async (q) => {
        seen = {
          graphExists: fs.existsSync(path.join(dataDir, 'graph.db')),
          buildingExists: fs.existsSync(path.join(dataDir, 'graph.db.building')),
          files: q.counts().files,
        };
      },
    });
    expect(seen).toEqual({ graphExists: false, buildingExists: true, files: 3 });
  });

  it('records a syntax error in files.errors and keeps indexing the rest', async () => {
    writeThreeFiles();
    write('src/broken.ts', 'export function ok() {\n  return 1;\n}\n\nfunction (\n');
    const result = await indexProject({ root, dataDir });

    expect(result.files).toBe(4);
    const rows = readFiles();
    const broken = rows.find((r) => r.path === 'src/broken.ts');
    expect(JSON.parse(broken?.errors ?? '[]')).not.toHaveLength(0);
    expect(rows.filter((r) => r.errors === null).map((r) => r.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
    const db = openGraphDb(path.join(dataDir, 'graph.db'), { readonly: true });
    try {
      expect(new GraphQueries(db).nodesByName('ok', 5)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('marks generated and test files', async () => {
    write('src/gen.ts', '// Code generated by protoc. DO NOT EDIT.\nexport const x = 1;\n');
    write('src/a.test.ts', 'export function t(): void {}\n');
    write('src/plain.ts', 'export const y = 2;\n');
    await indexProject({ root, dataDir });
    const rows = readFiles();
    expect(rows.map((r) => [r.path, r.generated, r.is_test])).toEqual([
      ['src/a.test.ts', 0, 1],
      ['src/gen.ts', 1, 0],
      ['src/plain.ts', 0, 0],
    ]);
  });

  it('abort mid-parse leaves no new graph.db, no .building and keeps the previous graph.db', async () => {
    for (let i = 0; i < 20; i++) write(`src/f${i}.ts`, `export function f${i}(): number { return ${i}; }\n`);
    fs.writeFileSync(path.join(dataDir, 'graph.db'), 'previous');
    const ac = new AbortController();
    const run = indexProject({
      root,
      dataDir,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.phase === 'parse' && p.filesDone >= 2) ac.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(dataFiles()).toEqual(['graph.db']);
    expect(fs.readFileSync(path.join(dataDir, 'graph.db'), 'utf8')).toBe('previous');

    const again = await indexProject({ root, dataDir });
    expect(again.files).toBe(20);
  });

  it('rejects a concurrent second run with INDEX_BUSY', async () => {
    writeThreeFiles();
    const [first, second] = await Promise.allSettled([
      indexProject({ root, dataDir }),
      indexProject({ root, dataDir }),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'INDEX_BUSY' } });
    expect(dataFiles()).toEqual(['graph.db']);
  });

  it('publishes a valid empty graph when there is no supported code', async () => {
    write('README.md', '# hi\n');
    write('notes/x.rb', 'puts 1\n');
    const result = await indexProject({ root, dataDir });
    expect(result.files).toBe(0);
    expect(result.languages).toEqual({});
    const db = openGraphDb(path.join(dataDir, 'graph.db'), { readonly: true });
    try {
      expect(new GraphQueries(db).counts()).toEqual({ nodes: 0, edges: 0, files: 0 });
    } finally {
      db.close();
    }
  });

  it('removes orphan building files left by a crash', async () => {
    writeThreeFiles();
    fs.writeFileSync(path.join(dataDir, 'graph.db.building'), 'junk');
    fs.writeFileSync(path.join(dataDir, 'graph.db.building-wal'), 'junk');
    fs.writeFileSync(path.join(dataDir, 'graph.db.building-shm'), 'junk');
    const result = await indexProject({ root, dataDir });
    expect(result.files).toBe(3);
    expect(dataFiles()).toEqual(['graph.db']);
  });

  it('replaces an existing graph.db on success', async () => {
    writeThreeFiles();
    await indexProject({ root, dataDir });
    write('src/d.ts', 'export const d = 4;\n');
    const result = await indexProject({ root, dataDir });
    expect(result.files).toBe(4);
    expect(readFiles().map((r) => r.path)).toContain('src/d.ts');
    expect(dataFiles()).toEqual(['graph.db']);
  });
});
