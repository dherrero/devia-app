import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openGraphDb } from '../db/connection';
import { GRAPH_DB_FILE, indexProject } from './orchestrator';

/** Every persisted column that a reader can observe, minus autoincrement ids and timestamps. */
export interface GraphSnapshot {
  nodes: string[];
  edges: string[];
  refs: string[];
  files: string[];
  languages: string;
}

const NODE_SQL = `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line,
  docstring, signature, is_exported, is_test, visibility, is_async, is_static, is_abstract,
  decorators, metadata FROM nodes`;
const EDGE_SQL = 'SELECT source, target, kind, line, col, provenance FROM edges';
const REF_SQL = `SELECT from_node_id, reference_name, reference_kind, line, col, file_path, language,
  status, name_tail, metadata FROM unresolved_refs`;
const FILE_SQL = `SELECT path, content_hash, language, size, modified_at, node_count, errors, generated,
  is_test FROM files`;

export function snapshotGraph(dataDir: string): GraphSnapshot {
  const db = openGraphDb(path.join(dataDir, GRAPH_DB_FILE), { readonly: true });
  try {
    const rows = (sql: string): string[] =>
      (db.prepare(sql).all() as unknown[]).map((r) => JSON.stringify(r)).sort();
    const meta = db.prepare("SELECT value FROM project_metadata WHERE key = 'languages'").get() as
      | { value: string }
      | undefined;
    const languages = Object.entries(JSON.parse(meta?.value ?? '{}') as Record<string, number>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return {
      nodes: rows(NODE_SQL),
      edges: rows(EDGE_SQL),
      refs: rows(REF_SQL),
      files: rows(FILE_SQL),
      languages,
    };
  } finally {
    db.close();
  }
}

/** Builds the reference graph: a full index of `root` in a throwaway data dir. */
export async function fullIndexSnapshot(root: string): Promise<GraphSnapshot> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parity-full-'));
  try {
    await fullIndex(root, dataDir);
    return snapshotGraph(dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** The default pipeline, exactly as the app runs it (resolution and communities in `postIndex`). */
export async function fullIndex(root: string, dataDir: string): Promise<void> {
  await indexProject({ root, dataDir });
}

/**
 * A temp project whose writes carry an explicit, strictly increasing mtime, so change
 * detection never depends on the file system's timestamp granularity.
 */
export class TestProject {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-root-'));
  private clock = Date.UTC(2026, 0, 1) / 1000;

  private tick(abs: string): void {
    this.clock += 10;
    fs.utimesSync(abs, this.clock, this.clock);
  }

  abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  write(rel: string, content: string): void {
    const abs = this.abs(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    this.tick(abs);
  }

  writeAll(files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) this.write(rel, content);
  }

  read(rel: string): string {
    return fs.readFileSync(this.abs(rel), 'utf8');
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.abs(rel));
  }

  remove(rel: string): void {
    fs.rmSync(this.abs(rel), { recursive: true, force: true });
  }

  rename(from: string, to: string): void {
    const dest = this.abs(to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(this.abs(from), dest);
  }

  touch(rel: string): void {
    this.tick(this.abs(rel));
  }

  dispose(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
