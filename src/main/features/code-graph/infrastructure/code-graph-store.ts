import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectKey } from '../../../shared/project-key';

const ROOT_DIR = 'code-graph';
const DB_FILE = 'graph.db';
const DOC_FILE = 'project.json';

export interface ProjectDoc {
  createdAt: number;
  indexedAt: number;
  autoUpdate: boolean;
  /** Absent means the agents may use the graph; only `false` is ever stored. */
  agentAccess?: false;
  builtAtCommit?: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseDoc(raw: unknown): ProjectDoc | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isFiniteNumber(r['createdAt']) || !isFiniteNumber(r['indexedAt']) || typeof r['autoUpdate'] !== 'boolean') {
    return undefined;
  }
  const doc: ProjectDoc = { createdAt: r['createdAt'], indexedAt: r['indexedAt'], autoUpdate: r['autoUpdate'] };
  if (r['agentAccess'] === false) doc.agentAccess = false;
  if (typeof r['builtAtCommit'] === 'string' && r['builtAtCommit'] !== '') doc.builtAtCommit = r['builtAtCommit'];
  return doc;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export class CodeGraphStore {
  constructor(private readonly deviaDir: () => string) {}

  private root(): string {
    return path.join(this.deviaDir(), ROOT_DIR);
  }

  dataDir(projectAbs: string): string {
    return path.join(this.root(), projectKey(projectAbs));
  }

  dbPath(projectAbs: string): string {
    return path.join(this.dataDir(projectAbs), DB_FILE);
  }

  exists(projectAbs: string): boolean {
    return fs.existsSync(this.dbPath(projectAbs));
  }

  loadDoc(projectAbs: string): ProjectDoc | undefined {
    try {
      return parseDoc(JSON.parse(fs.readFileSync(path.join(this.dataDir(projectAbs), DOC_FILE), 'utf8')));
    } catch {
      return undefined;
    }
  }

  saveDoc(projectAbs: string, doc: ProjectDoc): void {
    const dir = this.dataDir(projectAbs);
    fs.mkdirSync(dir, { recursive: true });
    const out: ProjectDoc = { createdAt: doc.createdAt, indexedAt: doc.indexedAt, autoUpdate: doc.autoUpdate };
    if (doc.agentAccess === false) out.agentAccess = false;
    if (doc.builtAtCommit !== undefined) out.builtAtCommit = doc.builtAtCommit;
    const file = path.join(dir, DOC_FILE);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  remove(projectAbs: string): void {
    const dir = this.dataDir(projectAbs);
    let target: string;
    try {
      target = fs.realpathSync(dir);
    } catch {
      if (!isInside(this.root(), path.resolve(dir))) throw outside(dir);
      return;
    }
    let base: string;
    try {
      base = fs.realpathSync(this.root());
    } catch {
      throw outside(dir);
    }
    if (!isInside(base, target) || !isInside(this.root(), path.resolve(dir))) throw outside(dir);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function outside(dir: string): Error {
  const err = new Error(`Refusing to remove ${dir}: outside the code-graph data directory`) as Error & { code: string };
  err.code = 'CODE_GRAPH_PATH_OUTSIDE';
  return err;
}
