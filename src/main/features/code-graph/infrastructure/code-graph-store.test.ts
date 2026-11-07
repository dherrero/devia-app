import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectKey } from '../../../shared/project-key';
import { CodeGraphStore, type ProjectDoc } from './code-graph-store';

let deviaDir: string;
let store: CodeGraphStore;
const project = path.join(path.sep, 'work', 'my-app');

beforeEach(() => {
  deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-'));
  store = new CodeGraphStore(() => deviaDir);
});

afterEach(() => {
  fs.rmSync(deviaDir, { recursive: true, force: true });
});

const fullDoc: ProjectDoc = {
  createdAt: 100,
  indexedAt: 200,
  autoUpdate: true,
  agentAccess: false,
  builtAtCommit: 'abc123',
};

describe('CodeGraphStore paths', () => {
  it('places data under <deviaDir>/code-graph/<projectKey>', () => {
    expect(store.dataDir(project)).toBe(path.join(deviaDir, 'code-graph', projectKey(project)));
    expect(store.dbPath(project)).toBe(path.join(store.dataDir(project), 'graph.db'));
  });

  it('exists reflects the presence of graph.db', () => {
    expect(store.exists(project)).toBe(false);
    fs.mkdirSync(store.dataDir(project), { recursive: true });
    fs.writeFileSync(store.dbPath(project), '');
    expect(store.exists(project)).toBe(true);
  });
});

describe('CodeGraphStore doc', () => {
  it('round-trips every field (regression: dropped flags)', () => {
    store.saveDoc(project, fullDoc);
    expect(store.loadDoc(project)).toEqual(fullDoc);
  });

  it('preserves autoUpdate false and true', () => {
    store.saveDoc(project, { createdAt: 1, indexedAt: 2, autoUpdate: false });
    expect(store.loadDoc(project)?.autoUpdate).toBe(false);
    store.saveDoc(project, { createdAt: 1, indexedAt: 2, autoUpdate: true });
    expect(store.loadDoc(project)?.autoUpdate).toBe(true);
  });

  it('omits agentAccess when enabled', () => {
    store.saveDoc(project, { createdAt: 1, indexedAt: 2, autoUpdate: true });
    const raw = JSON.parse(fs.readFileSync(path.join(store.dataDir(project), 'project.json'), 'utf8')) as Record<string, unknown>;
    expect('agentAccess' in raw).toBe(false);
    expect(store.loadDoc(project)?.agentAccess).toBeUndefined();
  });

  it('writes atomically and leaves no temp file', () => {
    store.saveDoc(project, fullDoc);
    store.saveDoc(project, { ...fullDoc, indexedAt: 300 });
    expect(fs.readdirSync(store.dataDir(project))).toEqual(['project.json']);
    expect(store.loadDoc(project)?.indexedAt).toBe(300);
  });

  it('returns undefined for a missing or corrupt doc without throwing', () => {
    expect(store.loadDoc(project)).toBeUndefined();
    fs.mkdirSync(store.dataDir(project), { recursive: true });
    const file = path.join(store.dataDir(project), 'project.json');
    fs.writeFileSync(file, '{not json');
    expect(store.loadDoc(project)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ createdAt: 'x', indexedAt: 1, autoUpdate: true }));
    expect(store.loadDoc(project)).toBeUndefined();
  });
});

describe('CodeGraphStore.remove', () => {
  it('deletes only that project directory', () => {
    const other = path.join(path.sep, 'work', 'other');
    store.saveDoc(project, fullDoc);
    store.saveDoc(other, fullDoc);
    store.remove(project);
    expect(fs.existsSync(store.dataDir(project))).toBe(false);
    expect(store.loadDoc(other)).toEqual(fullDoc);
  });

  it('accepts a project directory whose name merely starts with ..', () => {
    fs.mkdirSync(path.join(deviaDir, 'code-graph', '..foo'), { recursive: true });
    fs.writeFileSync(path.join(deviaDir, 'code-graph', '..foo', 'x'), '1');
    const odd = new CodeGraphStore(() => deviaDir);
    expect(odd.dataDir(path.join(path.sep, '..foo'))).toBe(path.join(deviaDir, 'code-graph', '..foo'));
    odd.remove(path.join(path.sep, '..foo'));
    expect(fs.existsSync(path.join(deviaDir, 'code-graph', '..foo'))).toBe(false);
  });

  it('is a no-op when nothing exists', () => {
    expect(() => store.remove(project)).not.toThrow();
  });

  it('refuses paths that escape code-graph/ via ..', () => {
    const victim = path.join(deviaDir, 'victim.txt');
    fs.writeFileSync(victim, 'x');
    fs.mkdirSync(path.join(deviaDir, 'code-graph'), { recursive: true });
    expect(() => store.remove('..')).toThrow();
    expect(() => store.remove('')).toThrow();
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.existsSync(path.join(deviaDir, 'code-graph'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('refuses a project directory that is a symlink out of code-graph/', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
      fs.mkdirSync(path.join(deviaDir, 'code-graph'), { recursive: true });
      fs.symlinkSync(outside, store.dataDir(project), 'dir');
      expect(() => store.remove(project)).toThrow();
      expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
