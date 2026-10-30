import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryStore } from './memory-store';

// ── fixtures ─────────────────────────────────────────────────────────

function setup() {
  const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-memory-'));
  const store = new MemoryStore(() => deviaDir);
  const project = '/home/user/my-project';
  const cleanup = () => fs.rmSync(deviaDir, { recursive: true, force: true });
  return { deviaDir, store, project, cleanup };
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

// ── keyForPath ────────────────────────────────────────────────────────

describe('MemoryStore.keyForPath', () => {
  it('strips leading and trailing separators', () => {
    expect(MemoryStore.keyForPath('/home/user/project')).toBe('home-user-project');
  });

  it('collapses multiple non-alphanumeric chars', () => {
    expect(MemoryStore.keyForPath('/foo//bar__baz')).toBe('foo-bar-baz');
  });
});

// ── fileFor ───────────────────────────────────────────────────────────

describe('MemoryStore.fileFor', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('personal scope points to memory-global.json', () => {
    const file = fx.store.fileFor('personal');
    expect(file).toMatch(/memory-global\.json$/);
  });

  it('project scope points to projects/<key>/memory.json', () => {
    const file = fx.store.fileFor('project', fx.project);
    const key = MemoryStore.keyForPath(fx.project);
    expect(file).toContain(path.join('projects', key, 'memory.json'));
  });

  it('project scope without path throws', () => {
    expect(() => fx.store.fileFor('project')).toThrow();
  });
});

// ── round-trip save / load ────────────────────────────────────────────

describe('MemoryStore — round-trip', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('personal scope: appended observation survives a new store instance', () => {
    const obs = fx.store.appendObservation({
      sessionId: 'ses-1',
      type: 'decision',
      title: 'Use JSON not SQLite',
      content: 'Avoids native module issues across OS.',
      scope: 'personal',
    });
    expect(obs.id).toBe('obs-1');

    // New store instance — no cache sharing.
    const fresh = new MemoryStore(() => fx.deviaDir);
    const doc = fresh.load('personal');
    expect(doc.observations).toHaveLength(1);
    expect(expectPresent(doc.observations[0]).title).toBe('Use JSON not SQLite');
    expect(doc.nextObsSeq).toBe(2);
  });

  it('project scope: appended observation survives a new store instance', () => {
    fx.store.appendObservation({
      sessionId: 'ses-1',
      type: 'bugfix',
      title: 'Fix null pointer',
      content: 'Guard undefined before access.',
      scope: 'project',
      projectPath: fx.project,
    });

    const fresh = new MemoryStore(() => fx.deviaDir);
    const doc = fresh.load('project', fx.project);
    expect(doc.observations).toHaveLength(1);
    expect(doc.scope).toBe('project');
    expect(doc.projectPath).toBe(fx.project);
  });

  it('ids are sequential across multiple appends', () => {
    const o1 = fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'A', content: '', scope: 'personal' });
    const o2 = fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'B', content: '', scope: 'personal' });
    const o3 = fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'C', content: '', scope: 'personal' });
    expect(o1.id).toBe('obs-1');
    expect(o2.id).toBe('obs-2');
    expect(o3.id).toBe('obs-3');
  });

  it('session and prompt ids follow their own counters', () => {
    const ses = fx.store.appendSession({
      scope: 'personal',
      project: 'myproj',
      directory: '/home/user/myproj',
      startedAt: Date.now(),
    });
    const prm = fx.store.appendPrompt({
      scope: 'personal',
      sessionId: ses.id,
      content: 'hello',
      createdAt: Date.now(),
    });
    expect(ses.id).toBe('ses-1');
    expect(prm.id).toBe('prm-1');
  });

  it('optional fields are omitted from the Observation when not provided', () => {
    const obs = fx.store.appendObservation({
      sessionId: 'ses-1',
      type: 'pattern',
      title: 'No optional fields',
      content: 'bare minimum',
      scope: 'personal',
    });
    expect('syncId' in obs).toBe(false);
    expect('project' in obs).toBe(false);
    expect('topicKey' in obs).toBe(false);
    expect('toolName' in obs).toBe(false);
    expect('deletedAt' in obs).toBe(false);
  });
});

// ── soft-delete ───────────────────────────────────────────────────────

describe('MemoryStore — soft-delete', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('soft-deleted observation is excluded from search results', () => {
    fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'keep', content: 'visible', scope: 'personal' });
    const del = fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'delete me', content: 'hidden', scope: 'personal' });
    fx.store.softDelete('personal', undefined, del.id);

    const hits = fx.store.search('personal', undefined, { query: 'delete' });
    expect(hits).toHaveLength(0);
  });

  it('soft-deleted observation is excluded from empty-query results', () => {
    const del = fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'gone', content: '', scope: 'personal' });
    fx.store.softDelete('personal', undefined, del.id);

    const hits = fx.store.search('personal', undefined, { query: '' });
    expect(hits).toHaveLength(0);
  });

  it('softDelete returns false for unknown id', () => {
    const result = fx.store.softDelete('personal', undefined, 'obs-999');
    expect(result).toBe(false);
  });

  it('softDelete returns false for already-deleted observation', () => {
    const obs = fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 't', content: '', scope: 'personal' });
    fx.store.softDelete('personal', undefined, obs.id);
    expect(fx.store.softDelete('personal', undefined, obs.id)).toBe(false);
  });

  it('softDelete persists to disk', () => {
    const obs = fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'to delete', content: '', scope: 'personal' });
    fx.store.softDelete('personal', undefined, obs.id);

    const fresh = new MemoryStore(() => fx.deviaDir);
    const loaded = fresh.getObservation('personal', undefined, obs.id);
    expect(loaded?.deletedAt).toBeTypeOf('number');
  });
});

// ── invalidate ────────────────────────────────────────────────────────

describe('MemoryStore — invalidate', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('forces re-read from disk after external mutation', () => {
    fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'original', content: '', scope: 'personal' });

    // Simulate an out-of-process write by a second store instance.
    const external = new MemoryStore(() => fx.deviaDir);
    external.appendObservation({ sessionId: 's', type: 'decision', title: 'external write', content: '', scope: 'personal' });

    // Without invalidate the first store's cache still shows 1 observation.
    const beforeInvalidate = fx.store.load('personal').observations;
    expect(beforeInvalidate).toHaveLength(1);

    fx.store.invalidate('personal');
    const afterInvalidate = fx.store.load('personal').observations;
    expect(afterInvalidate).toHaveLength(2);
  });
});

// ── search / scoring ──────────────────────────────────────────────────

describe('MemoryStore — search scoring', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('title match ranks higher than content-only match', () => {
    // "typescript" appears only in content
    fx.store.appendObservation({
      sessionId: 's', type: 'manual',
      title: 'Architecture note',
      content: 'We use typescript for type safety',
      scope: 'personal',
    });
    // "typescript" appears in title
    fx.store.appendObservation({
      sessionId: 's', type: 'decision',
      title: 'Choose typescript over javascript',
      content: 'General reasoning',
      scope: 'personal',
    });

    const hits = fx.store.search('personal', undefined, { query: 'typescript' });
    expect(hits).toHaveLength(2);
    // Title match (score = 3) must outrank content match (score = 1).
    expect(expectPresent(hits[0]).observation.title).toBe('Choose typescript over javascript');
    expect(expectPresent(hits[0]).score).toBeGreaterThan(expectPresent(hits[1]).score);
  });

  it('multi-token query accumulates score across all tokens', () => {
    fx.store.appendObservation({
      sessionId: 's', type: 'manual',
      title: 'memory store design',
      content: 'Uses JSON persistence',
      scope: 'personal',
    });
    fx.store.appendObservation({
      sessionId: 's', type: 'manual',
      title: 'memory',
      content: 'just one token',
      scope: 'personal',
    });

    const hits = fx.store.search('personal', undefined, { query: 'memory store' });
    expect(expectPresent(hits[0]).score).toBeGreaterThan(expectPresent(hits[1]).score);
  });

  it('applies type filter', () => {
    fx.store.appendObservation({ sessionId: 's', type: 'decision', title: 'decision obs', content: '', scope: 'personal' });
    fx.store.appendObservation({ sessionId: 's', type: 'bugfix', title: 'bugfix obs', content: '', scope: 'personal' });

    const hits = fx.store.search('personal', undefined, { query: '', type: 'decision' });
    expect(hits).toHaveLength(1);
    expect(expectPresent(hits[0]).observation.type).toBe('decision');
  });

  it('applies project filter', () => {
    fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'proj A', content: '', scope: 'personal', project: '/projectA' });
    fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'proj B', content: '', scope: 'personal', project: '/projectB' });

    const hits = fx.store.search('personal', undefined, { query: '', project: '/projectA' });
    expect(hits).toHaveLength(1);
    expect(expectPresent(hits[0]).observation.project).toBe('/projectA');
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      fx.store.appendObservation({ sessionId: 's', type: 'manual', title: `obs ${i}`, content: '', scope: 'personal' });
    }
    const hits = fx.store.search('personal', undefined, { query: '', limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it('returns observations sorted by updatedAt when scores are equal', () => {
    const earlier = fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'alpha', content: '', scope: 'personal' });
    // Force different updatedAt by bumping time slightly.
    const doc = fx.store.load('personal');
    const obs = expectPresent(doc.observations.find((o) => o.id === earlier.id));
    obs.updatedAt = Date.now() - 5000;
    fx.store.save(doc);
    fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'beta', content: '', scope: 'personal' });

    const hits = fx.store.search('personal', undefined, { query: '' });
    expect(expectPresent(hits[0]).observation.title).toBe('beta');
  });
});

// ── defensive parser ──────────────────────────────────────────────────

describe('MemoryStore — defensive parser', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('corrupt JSON yields a fresh document', () => {
    const file = fx.store.fileFor('personal');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not valid json }', 'utf8');

    const doc = fx.store.load('personal');
    expect(doc.observations).toHaveLength(0);
    expect(doc.version).toBe(1);
    expect(doc.nextObsSeq).toBe(1);
  });

  it('wrong version yields a fresh document', () => {
    const file = fx.store.fileFor('personal');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99, observations: [], sessions: [], prompts: [] }), 'utf8');

    const doc = fx.store.load('personal');
    expect(doc.observations).toHaveLength(0);
  });

  it('missing arrays default to empty without crashing', () => {
    const file = fx.store.fileFor('personal');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // version is correct but arrays are absent
    fs.writeFileSync(file, JSON.stringify({ version: 1, scope: 'personal' }), 'utf8');

    const doc = fx.store.load('personal');
    expect(doc.observations).toHaveLength(0);
    expect(doc.sessions).toHaveLength(0);
    expect(doc.prompts).toHaveLength(0);
  });

  it('partially malformed observation entries are silently dropped', () => {
    const file = fx.store.fileFor('personal');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      scope: 'personal',
      observations: [null, 'string', { id: 'obs-1', sessionId: 's', type: 'manual', title: 'ok', content: '', scope: 'personal', createdAt: 0, updatedAt: 0 }],
      sessions: [],
      prompts: [],
      nextObsSeq: 2,
      nextSessionSeq: 1,
      nextPromptSeq: 1,
    }), 'utf8');

    const doc = fx.store.load('personal');
    expect(doc.observations).toHaveLength(1);
    expect(expectPresent(doc.observations[0]).title).toBe('ok');
  });
});

// ── getObservation ────────────────────────────────────────────────────

describe('MemoryStore.getObservation', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('returns the observation by id', () => {
    const obs = fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 'found', content: '', scope: 'personal' });
    expect(expectPresent(fx.store.getObservation('personal', undefined, obs.id)).title).toBe('found');
  });

  it('returns undefined for unknown id', () => {
    expect(fx.store.getObservation('personal', undefined, 'obs-999')).toBeUndefined();
  });
});

// ── agentId (S-2 F1.1) ────────────────────────────────────────────────

describe('MemoryStore — agentId on records (S-2 F1.1)', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('appendObservation / appendSession / appendPrompt persist agentId', () => {
    fx.store.appendObservation({ sessionId: 's', type: 'manual', title: 't', content: '', scope: 'project', projectPath: fx.project, agentId: 'claude' });
    fx.store.appendSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 1, agentId: 'codex' });
    fx.store.appendPrompt({ scope: 'project', projectPath: fx.project, sessionId: 's', content: 'c', createdAt: 1, agentId: 'gemini' });

    const fresh = new MemoryStore(() => fx.deviaDir).load('project', fx.project);
    expect(expectPresent(fresh.observations[0]).agentId).toBe('claude');
    expect(expectPresent(fresh.sessions[0]).agentId).toBe('codex');
    expect(expectPresent(fresh.prompts[0]).agentId).toBe('gemini');
  });

  it('upsertSession preserves the stored agentId when the update omits it and overwrites when provided', () => {
    fx.store.appendSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 1, sessionId: 'run-1', agentId: 'claude' });

    fx.store.upsertSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 2, sessionId: 'run-1', summary: 'sin agente' });
    let doc = fx.store.load('project', fx.project);
    expect(expectPresent(doc.sessions[0]).agentId).toBe('claude');

    fx.store.upsertSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 3, sessionId: 'run-1', summary: 'traspaso', agentId: 'codex' });
    doc = fx.store.load('project', fx.project);
    expect(expectPresent(doc.sessions[0]).agentId).toBe('codex');
  });

  it('upsertSession auto:true never replaces a manual summary (only endedAt/agentId refresh)', () => {
    fx.store.upsertSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 1, sessionId: 'run-1', summary: 'resumen rico del agente' });

    fx.store.upsertSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 1, endedAt: 99, sessionId: 'run-1', summary: 'Auto-captured run', auto: true });

    const ses = expectPresent(fx.store.load('project', fx.project).sessions[0]);
    expect(ses.summary).toBe('resumen rico del agente');
    expect(ses.auto).not.toBe(true);
    expect(ses.endedAt).toBe(99);
  });

  it('upsertSession: a manual summary upgrades an auto record AND clears the stale auto flag', () => {
    // Run 1 ends → passive auto-capture.
    fx.store.upsertSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 1, endedAt: 2, sessionId: 'run-1', summary: 'Auto-captured run 1', auto: true });
    // Run 2: the agent records a rich mem_session_summary (no auto flag).
    fx.store.upsertSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 1, endedAt: 3, sessionId: 'run-1', summary: 'resumen rico del agente' });
    // Run 2 ends → passive auto-capture again. It must NOT clobber the manual one.
    fx.store.upsertSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 1, endedAt: 4, sessionId: 'run-1', summary: 'Auto-captured run 2', auto: true });

    const ses = expectPresent(fx.store.load('project', fx.project).sessions[0]);
    expect(ses.summary).toBe('resumen rico del agente');
    expect(ses.auto).not.toBe(true);
    expect(ses.endedAt).toBe(4);
  });

  it('upsertSession auto refreshes a previous auto summary', () => {
    fx.store.upsertSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 1, sessionId: 'run-1', summary: 'Auto 1', auto: true });
    fx.store.upsertSession({ scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 1, sessionId: 'run-1', summary: 'Auto 2', auto: true });

    const ses = expectPresent(fx.store.load('project', fx.project).sessions[0]);
    expect(ses.summary).toBe('Auto 2');
    expect(ses.auto).toBe(true);
  });

  it('normalise tolerates legacy files without agentId', () => {
    const file = fx.store.fileFor('personal');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      scope: 'personal',
      observations: [{ id: 'obs-1', sessionId: 's', type: 'manual', title: 'old', content: '', scope: 'personal', createdAt: 0, updatedAt: 0 }],
      sessions: [{ id: 'ses-1', project: 'p', directory: '/d', startedAt: 0 }],
      prompts: [{ id: 'prm-1', sessionId: 's', content: 'c', createdAt: 0 }],
      nextObsSeq: 2,
      nextSessionSeq: 2,
      nextPromptSeq: 2,
    }), 'utf8');

    const doc = fx.store.load('personal');
    expect('agentId' in expectPresent(doc.observations[0])).toBe(false);
    expect('agentId' in expectPresent(doc.sessions[0])).toBe(false);
    expect('agentId' in expectPresent(doc.prompts[0])).toBe(false);
  });
});

// ── cross-process lost-update guard ───────────────────────────────────
//
// The devia-memory MCP server mutates the same memory.json from another
// process. A second MemoryStore instance over the same deviaDir models it:
// no cache sharing, only the file. Before the fix, a mutation on a store
// with a warm (stale) cache wrote the stale doc back and silently dropped
// everything the other process had written since (this is how the graphify
// mem_save observations were lost to the run-end auto-summary).

describe('MemoryStore — mutations re-read disk (cross-process lost-update)', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  function outOfProcessStore(): MemoryStore {
    return new MemoryStore(() => fx.deviaDir);
  }

  it('an out-of-process mem_save survives the run-end auto-summary written from a warm cache', () => {
    fx.store.load('project', fx.project); // run start warms the main-process cache

    outOfProcessStore().appendObservation({
      sessionId: 'run-1', type: 'manual', title: 'RESUMEN graphify', content: 'estado de la rama', scope: 'project', projectPath: fx.project,
    });

    fx.store.upsertSession({
      scope: 'project', projectPath: fx.project, project: 'p', directory: fx.project, startedAt: 1, endedAt: 2, sessionId: 'run-1', summary: 'Auto-captured run', auto: true,
    });

    const onDisk = outOfProcessStore().load('project', fx.project);
    expect(onDisk.observations).toHaveLength(1);
    expect(expectPresent(onDisk.observations[0]).title).toBe('RESUMEN graphify');
    expect(onDisk.sessions).toHaveLength(1);
  });

  it('an out-of-process mem_save survives a later cached appendPrompt', () => {
    fx.store.load('project', fx.project);

    outOfProcessStore().appendObservation({
      sessionId: 'run-1', type: 'manual', title: 'obs externa', content: '', scope: 'project', projectPath: fx.project,
    });

    fx.store.appendPrompt({ scope: 'project', projectPath: fx.project, sessionId: 'run-1', content: 'hola', createdAt: 1 });

    const onDisk = outOfProcessStore().load('project', fx.project);
    expect(onDisk.observations).toHaveLength(1);
    expect(onDisk.prompts).toHaveLength(1);
  });

  it('id counters continue from the out-of-process sequence instead of reusing ids', () => {
    fx.store.load('project', fx.project);

    outOfProcessStore().appendObservation({
      sessionId: 's', type: 'manual', title: 'A', content: '', scope: 'project', projectPath: fx.project,
    });

    const obs = fx.store.appendObservation({
      sessionId: 's', type: 'manual', title: 'B', content: '', scope: 'project', projectPath: fx.project,
    });
    expect(obs.id).toBe('obs-2');
  });

  it('softDelete and setPinned operate on the doc on disk, not the cached copy', () => {
    const external = outOfProcessStore();
    const obs = external.appendObservation({
      sessionId: 's', type: 'manual', title: 'pin me', content: '', scope: 'project', projectPath: fx.project,
    });
    fx.store.load('project', fx.project); // warm cache WITH the observation
    external.appendObservation({
      sessionId: 's', type: 'manual', title: 'second', content: '', scope: 'project', projectPath: fx.project,
    });

    expect(fx.store.setPinned('project', fx.project, obs.id, true)).toBeDefined();

    const onDisk = outOfProcessStore().load('project', fx.project);
    expect(onDisk.observations).toHaveLength(2);
    expect(expectPresent(onDisk.observations.find((o) => o.id === obs.id)).pinned).toBe(true);
  });
});
