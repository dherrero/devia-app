import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryStore } from '../infrastructure/memory-store';
import {
  ImportEngramUseCase,
  parseSqliteTimestamp,
  type ExportRunner,
  type FileFns,
  type MarkImportedFn,
} from './import-engram.use-case';

// ── fixture data ──────────────────────────────────────────────────────────

const FIXTURE_EXPORT = {
  version: '1',
  exported_at: '2026-05-24T10:00:00Z',
  sessions: [
    {
      id: 1,
      project: 'my-project',
      directory: '/home/user/my-project',
      started_at: '2026-05-20 09:00:00',
      ended_at: '2026-05-20 10:00:00',
      summary: 'Implemented login',
    },
  ],
  observations: [
    {
      id: 1,
      sync_id: 'sync-001',
      session_id: '1',
      type: 'decision',
      title: 'Use JWT',
      content: 'We chose JWT for stateless auth',
      tool_name: 'mem_save',
      project: 'my-project',
      scope: 'project',
      topic_key: 'auth',
      revision_count: 1,
      duplicate_count: 0,
      last_seen_at: null,
      created_at: '2026-05-20 09:15:00',
      updated_at: '2026-05-20 09:15:00',
      deleted_at: null,
    },
    {
      id: 2,
      sync_id: 'sync-002',
      session_id: '1',
      type: 'bugfix',
      title: 'Fix null pointer',
      content: 'Guard undefined before access',
      tool_name: null,
      project: null,
      scope: 'personal',
      topic_key: null,
      revision_count: 1,
      duplicate_count: 0,
      last_seen_at: null,
      created_at: '2026-05-20 09:30:00',
      updated_at: '2026-05-20 09:30:00',
      deleted_at: null,
    },
    // This one is soft-deleted — must be omitted.
    {
      id: 3,
      sync_id: 'sync-003',
      session_id: '1',
      type: 'manual',
      title: 'Deleted note',
      content: 'Should not be imported',
      tool_name: null,
      project: null,
      scope: 'personal',
      topic_key: null,
      revision_count: 1,
      duplicate_count: 0,
      last_seen_at: null,
      created_at: '2026-05-20 09:45:00',
      updated_at: '2026-05-20 09:45:00',
      deleted_at: '2026-05-20 10:00:00',  // non-null → skip
    },
  ],
  prompts: [
    {
      id: 1,
      sync_id: 'prm-sync-001',
      session_id: '1',
      content: 'What is the auth flow?',
      project: 'my-project',
      created_at: '2026-05-20 09:10:00',
    },
  ],
};

// ── fake builders ─────────────────────────────────────────────────────────

function makeSuccessRunner(fixture: object = FIXTURE_EXPORT): ExportRunner {
  const json = JSON.stringify(fixture);
  return {
    run: vi.fn().mockImplementation(async (bin: string, args: string[], timeout: number) => {
      void bin;
      void timeout;
      // Write the fixture JSON to the tmp file path (args[1]).
      const tmpFile = args[1];
      if (typeof tmpFile === 'string') {
        fs.writeFileSync(tmpFile, json, 'utf8');
      }
    }),
  };
}

function makeTimeoutRunner(): ExportRunner {
  return {
    run: vi.fn().mockRejectedValue(new Error('Process timed out')),
  };
}

function makeFailRunner(stderr = 'some error'): ExportRunner {
  return {
    run: vi.fn().mockRejectedValue(new Error(stderr)),
  };
}

function makeNodeFileFnsForTest(): FileFns {
  return {
    readUtf8: (p: string) => fs.readFileSync(p, 'utf8'),
    writeUtf8: (p: string, c: string) => fs.writeFileSync(p, c, 'utf8'),
    deleteFile: (p: string) => { try { fs.unlinkSync(p); } catch { /* ok */ } },
    makeTempPath: (suffix: string) =>
      path.join(os.tmpdir(), `test-engram-${Date.now()}${suffix}`),
  };
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

// ── store setup ───────────────────────────────────────────────────────────

function setupStore() {
  const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-engram-import-'));
  const store = new MemoryStore(() => deviaDir);
  const cleanup = () => fs.rmSync(deviaDir, { recursive: true, force: true });
  return { store, cleanup };
}

// ── parseSqliteTimestamp ──────────────────────────────────────────────────

describe('parseSqliteTimestamp', () => {
  it('converts a SQLite datetime string to epoch ms', () => {
    const ts = parseSqliteTimestamp('2026-05-24 10:30:00');
    // 2026-05-24T10:30:00Z = 1748082600000
    expect(ts).toBe(Date.parse('2026-05-24T10:30:00Z'));
  });

  it('returns Date.now() fallback for null input', () => {
    const before = Date.now();
    const ts = parseSqliteTimestamp(null);
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('returns Date.now() fallback for undefined input', () => {
    const before = Date.now();
    const ts = parseSqliteTimestamp(undefined);
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('returns Date.now() fallback for unparseable string', () => {
    const before = Date.now();
    const ts = parseSqliteTimestamp('not a date');
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ── successful import ─────────────────────────────────────────────────────

describe('ImportEngramUseCase — successful import', () => {
  let fx: ReturnType<typeof setupStore>;
  beforeEach(() => { fx = setupStore(); });
  afterEach(() => fx.cleanup());

  it('imports active observations and skips soft-deleted ones', async () => {
    const markImported: MarkImportedFn = vi.fn();
    const uc = new ImportEngramUseCase(
      makeSuccessRunner(),
      fx.store,
      makeNodeFileFnsForTest(),
      markImported,
    );

    const result = await uc.execute('/usr/bin/engram');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 2 active observations (sync-001, sync-002); 1 soft-deleted (sync-003) skipped.
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.sessions).toBe(1);
    expect(result.prompts).toBe(1);

    const doc = fx.store.load('personal');
    expect(doc.observations).toHaveLength(2);
    expect(doc.observations.find((o) => o.title === 'Deleted note')).toBeUndefined();
  });

  it('sets syncId on imported observations', async () => {
    const uc = new ImportEngramUseCase(
      makeSuccessRunner(),
      fx.store,
      makeNodeFileFnsForTest(),
      vi.fn(),
    );
    await uc.execute('/usr/bin/engram');

    const doc = fx.store.load('personal');
    const syncIds = doc.observations.map((o) => o.syncId);
    expect(syncIds).toContain('sync-001');
    expect(syncIds).toContain('sync-002');
  });

  it('correctly maps field types (type, topicKey, toolName, project)', async () => {
    const uc = new ImportEngramUseCase(
      makeSuccessRunner(),
      fx.store,
      makeNodeFileFnsForTest(),
      vi.fn(),
    );
    await uc.execute('/usr/bin/engram');

    const doc = fx.store.load('personal');
    const obs001 = expectPresent(doc.observations.find((o) => o.syncId === 'sync-001'));
    expect(obs001.type).toBe('decision');
    expect(obs001.topicKey).toBe('auth');
    expect(obs001.toolName).toBe('mem_save');
    expect(obs001.project).toBe('my-project');
    expect(obs001.scope).toBe('personal'); // all land in personal
  });

  it('parses SQLite timestamps correctly', async () => {
    const uc = new ImportEngramUseCase(
      makeSuccessRunner(),
      fx.store,
      makeNodeFileFnsForTest(),
      vi.fn(),
    );
    await uc.execute('/usr/bin/engram');

    const doc = fx.store.load('personal');
    const obs001 = expectPresent(doc.observations.find((o) => o.syncId === 'sync-001'));
    expect(obs001.createdAt).toBe(Date.parse('2026-05-20T09:15:00Z'));
    expect(obs001.updatedAt).toBe(Date.parse('2026-05-20T09:15:00Z'));
  });

  it('calls markImported with a current timestamp on success', async () => {
    const markImported: MarkImportedFn = vi.fn();
    const uc = new ImportEngramUseCase(
      makeSuccessRunner(),
      fx.store,
      makeNodeFileFnsForTest(),
      markImported,
    );
    const before = Date.now();
    await uc.execute('/usr/bin/engram');
    const after = Date.now();

    expect(markImported).toHaveBeenCalledOnce();
    const firstCall = expectPresent((markImported as ReturnType<typeof vi.fn>).mock.calls[0]);
    const calledWith = firstCall[0] as number;
    expect(calledWith).toBeGreaterThanOrEqual(before);
    expect(calledWith).toBeLessThanOrEqual(after);
  });
});

// ── idempotency (re-import skips by syncId) ───────────────────────────────

describe('ImportEngramUseCase — idempotency', () => {
  let fx: ReturnType<typeof setupStore>;
  beforeEach(() => { fx = setupStore(); });
  afterEach(() => fx.cleanup());

  it('re-import skips already-imported observations by syncId', async () => {
    const markImported: MarkImportedFn = vi.fn();
    const uc = new ImportEngramUseCase(
      makeSuccessRunner(),
      fx.store,
      makeNodeFileFnsForTest(),
      markImported,
    );

    // First import.
    const first = await uc.execute('/usr/bin/engram');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.imported).toBe(2);

    // Second import with the same data.
    const second = await uc.execute('/usr/bin/engram');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);

    // The store must still have exactly 2 observations (no duplicates).
    const doc = fx.store.load('personal');
    expect(doc.observations).toHaveLength(2);
  });
});

// ── error cases ───────────────────────────────────────────────────────────

describe('ImportEngramUseCase — error cases', () => {
  let fx: ReturnType<typeof setupStore>;
  beforeEach(() => { fx = setupStore(); });
  afterEach(() => fx.cleanup());

  it('returns engram-binary-missing when binPath is undefined', async () => {
    const uc = new ImportEngramUseCase(
      makeSuccessRunner(),
      fx.store,
      makeNodeFileFnsForTest(),
      vi.fn(),
    );
    const result = await uc.execute(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('engram-binary-missing');
  });

  it('returns engram-export-timeout when runner times out', async () => {
    const uc = new ImportEngramUseCase(
      makeTimeoutRunner(),
      fx.store,
      makeNodeFileFnsForTest(),
      vi.fn(),
    );
    const result = await uc.execute('/usr/bin/engram');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('engram-export-timeout');
  });

  it('returns engram-export-failed on non-zero exit', async () => {
    const uc = new ImportEngramUseCase(
      makeFailRunner('engram: database locked'),
      fx.store,
      makeNodeFileFnsForTest(),
      vi.fn(),
    );
    const result = await uc.execute('/usr/bin/engram');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('engram-export-failed');
    expect((result as { stderr: string }).stderr).toContain('database locked');
  });

  it('returns engram-parse-error for invalid JSON', async () => {
    const badRunner: ExportRunner = {
      run: vi.fn().mockImplementation(async (_bin: string, args: string[]) => {
        const tmpFile = args[1];
        if (typeof tmpFile === 'string') {
          fs.writeFileSync(tmpFile, '{ not valid json }', 'utf8');
        }
      }),
    };
    const uc = new ImportEngramUseCase(
      badRunner,
      fx.store,
      makeNodeFileFnsForTest(),
      vi.fn(),
    );
    const result = await uc.execute('/usr/bin/engram');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('engram-parse-error');
  });

  it('does not call markImported on failure', async () => {
    const markImported: MarkImportedFn = vi.fn();
    const uc = new ImportEngramUseCase(
      makeFailRunner(),
      fx.store,
      makeNodeFileFnsForTest(),
      markImported,
    );
    await uc.execute('/usr/bin/engram');
    expect(markImported).not.toHaveBeenCalled();
  });
});

// ── empty export ──────────────────────────────────────────────────────────

describe('ImportEngramUseCase — empty export', () => {
  let fx: ReturnType<typeof setupStore>;
  beforeEach(() => { fx = setupStore(); });
  afterEach(() => fx.cleanup());

  it('handles a valid empty export (zero observations) without error', async () => {
    const emptyFixture = {
      version: '1',
      exported_at: '2026-05-24T10:00:00Z',
      sessions: [],
      observations: [],
      prompts: [],
    };
    const uc = new ImportEngramUseCase(
      makeSuccessRunner(emptyFixture),
      fx.store,
      makeNodeFileFnsForTest(),
      vi.fn(),
    );
    const result = await uc.execute('/usr/bin/engram');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
