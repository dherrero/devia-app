import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FsSessionStore } from './fs-session-store';
import type { ConfigRepository } from '../../../shared/ports';
import type { DeviaConfig } from '../../../../shared/domain/config';
import type { PersistedSession } from '../../../../shared/domain/session';
import { parsePersistedSession } from '../../../../shared/domain/session';

// ── parsePersistedSession unit tests ─────────────────────────────────────────
describe('parsePersistedSession', () => {
  const valid = { id: 'abc', project: 'proj', createdAt: 0, updatedAt: 1, messages: [] };

  it('returns session for a valid object', () => {
    expect(parsePersistedSession(valid)).toEqual(valid);
  });

  it('returns null when id is missing', () => {
    expect(parsePersistedSession({ ...valid, id: '' })).toBeNull();
  });

  it('returns null when createdAt is not a number', () => {
    expect(parsePersistedSession({ ...valid, createdAt: 'nope' })).toBeNull();
  });

  it('returns null when messages is not an array', () => {
    expect(parsePersistedSession({ ...valid, messages: null })).toBeNull();
  });

  it('returns session when extra fields are present (forward-compatible)', () => {
    const withExtra = { ...valid, futureField: 42 };
    expect(parsePersistedSession(withExtra)).not.toBeNull();
  });

  it('returns null for null / non-object', () => {
    expect(parsePersistedSession(null)).toBeNull();
    expect(parsePersistedSession('string')).toBeNull();
    expect(parsePersistedSession([])).toBeNull();
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(workspaceRoot: string, deviaDataDir: string): ConfigRepository {
  return {
    get: () => ({ workspaceRoot } as DeviaConfig),
    set: () => { throw new Error('not used'); },
    reload: () => { throw new Error('not used'); },
    hasWorkspace: () => true,
    configPath: () => path.join(deviaDataDir, 'devia-app.config.json'),
    deviaDir: () => deviaDataDir,
  };
}

function makeSession(id: string, project = 'my-project'): PersistedSession {
  return { id, project, messages: [], createdAt: 1000, updatedAt: 2000 };
}

let workspace: string;
let dataDir: string;
let store: FsSessionStore;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-sessions-ws-'));
  dataDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-sessions-data-'));
  store     = new FsSessionStore(makeConfig(workspace, dataDir));
});

afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* swallow */ }
  try { fs.rmSync(dataDir,   { recursive: true, force: true }); } catch { /* swallow */ }
});

// ── Round-trip with a valid path ───────────────────────────────────────────

describe('FsSessionStore — path validation', () => {
  it('saves and loads a session for a valid project path', () => {
    const session = makeSession(store.newSessionId());
    store.save('my-project', session);
    const loaded = store.load('my-project', session.id);
    expect(loaded?.id).toBe(session.id);
  });

  it('lists sessions for a valid project path', () => {
    const s1 = makeSession(store.newSessionId());
    const s2 = makeSession(store.newSessionId());
    store.save('proj', s1);
    store.save('proj', s2);
    const list = store.list('proj');
    expect(list.map(s => s.id)).toContain(s1.id);
    expect(list.map(s => s.id)).toContain(s2.id);
  });

  // ── Path traversal guards ──────────────────────────────────────────────

  it('returns null for projectDir on ".." traversal — save is a no-op', () => {
    const session = makeSession(store.newSessionId());
    // Should not throw; should silently refuse.
    store.save('../../outside', session);
    // No file should exist outside the data dir.
    const escaped = path.resolve(workspace, '../../outside');
    expect(fs.existsSync(escaped)).toBe(false);
  });

  it('returns [] on list() for ".." traversal', () => {
    const result = store.list('../../outside');
    expect(result).toEqual([]);
  });

  it('returns null on load() for ".." traversal', () => {
    const result = store.load('../../outside', store.newSessionId());
    expect(result).toBeNull();
  });

  it('ignores deleteOne() for ".." traversal', () => {
    // Should not throw.
    expect(() => store.deleteOne('../../outside', store.newSessionId())).not.toThrow();
  });

  it('refuses absolute paths as projectPath — save is a no-op', () => {
    const session = makeSession(store.newSessionId());
    const absPath = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    store.save(absPath, session);
    // Session file must not exist at the absolute path.
    expect(fs.existsSync(path.join(absPath, `session-${session.id}.json`))).toBe(false);
  });

  it('returns [] on list() for absolute projectPath', () => {
    const absPath = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    expect(store.list(absPath)).toEqual([]);
  });

  // UC-FIX-008: validation on read and write
  it('AC1: load() returns null and warns for a malformed session file', () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = store.newSessionId();
    // First save a valid session so the directory structure is created.
    const session = makeSession(id, 'proj');
    store.save('proj', session);
    // Overwrite the session file directly with garbage to simulate corruption.
    // projectsRoot() = deviaDir()/projects;
    // projectKey = abs.replace(/[/\\:]/g, '-').replace(/^-/, '') — the leading
    // dash strip matters on POSIX, where abs starts with '/'.
    const abs = path.resolve(workspace, 'proj');
    const projKey = abs.replace(/[/\\:]/g, '-').replace(/^-/, '');
    const projRoot = path.join(dataDir, 'projects', projKey);
    const corruptedFile = path.join(projRoot, `session-${id}.json`);
    fs.writeFileSync(corruptedFile, JSON.stringify({ extra: 'no required fields' }));

    const result = store.load('proj', id);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed'));
    warnSpy.mockRestore();
  });

  it('AC2: save() throws when given a session missing required fields', () => {
    const bad = { id: '', project: 'proj', createdAt: 0, updatedAt: 0, messages: [] } as unknown as PersistedSession;
    expect(() => store.save('proj', bad)).toThrow('Invalid PersistedSession');
  });

  it('AC3: valid session round-trips correctly', () => {
    const session = makeSession(store.newSessionId());
    store.save('proj', session);
    const loaded = store.load('proj', session.id);
    expect(loaded?.id).toBe(session.id);
  });
});

// ── collectAllStats (S-7 T-84) ──────────────────────────────────────────────

describe('FsSessionStore — collectAllStats', () => {
  it('collects stored rollups and derives missing ones across all projects', () => {
    // Project A: one session with a stored rollup.
    store.save('proj-a', {
      id: store.newSessionId(), project: 'proj-a', messages: [], createdAt: 1, updatedAt: 2,
      stats: { agentId: 'claude', model: 'claude-opus-4-8', costUsd: 0.5, turnCount: 1, compactions: [], updatedAt: 2 },
    });
    // Project B: one session with no rollup but a costed assistant turn → derived.
    store.save('proj-b', {
      id: store.newSessionId(), project: 'proj-b', createdAt: 1, updatedAt: 2,
      messages: [{ role: 'assistant', model: 'gpt-5', usage: { costUsd: 0.2, inputTokens: 100 } }],
    });

    const all = store.collectAllStats();
    expect(all).toHaveLength(2);
    const total = all.reduce((s, r) => s + r.costUsd, 0);
    expect(Math.round(total * 100) / 100).toBe(0.7);
  });

  it('returns an empty array when there are no projects', () => {
    expect(store.collectAllStats()).toEqual([]);
  });
});
