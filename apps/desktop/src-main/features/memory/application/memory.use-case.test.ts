import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryStore } from '../infrastructure/memory-store';
import { MemoryUseCase } from './memory.use-case';

// ── fixtures ──────────────────────────────────────────────────────────────

function setup() {
  const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-memory-uc-'));
  const store = new MemoryStore(() => deviaDir);
  const useCase = new MemoryUseCase(store);
  const projectPath = '/home/user/my-project';
  const cleanup = () => fs.rmSync(deviaDir, { recursive: true, force: true });
  return { deviaDir, store, useCase, projectPath, cleanup };
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

// ── save ─────────────────────────────────────────────────────────────────

describe('MemoryUseCase.save', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('creates an observation and returns it', () => {
    const obs = fx.useCase.save({
      title: 'Use JSON',
      content: 'Avoids native deps',
      scope: 'personal',
    });
    expect(obs.id).toBe('obs-1');
    expect(obs.type).toBe('manual');
    expect(obs.title).toBe('Use JSON');
  });

  it('uses the provided type when given', () => {
    const obs = fx.useCase.save({
      title: 'A decision',
      content: 'We decided X',
      type: 'decision',
      scope: 'personal',
    });
    expect(obs.type).toBe('decision');
  });

  it('defaults scope to project when not specified', () => {
    const obs = fx.useCase.save({
      title: 'Project note',
      content: 'Something',
      projectPath: fx.projectPath,
    });
    expect(obs.scope).toBe('project');
  });

  it('dedup: same title+content (case-insensitive, trimmed) returns existing observation', () => {
    const first = fx.useCase.save({
      title: 'Same Title',
      content: 'Same content',
      scope: 'personal',
    });
    const second = fx.useCase.save({
      title: '  same title  ',
      content: 'Same Content',
      scope: 'personal',
    });
    expect(second.id).toBe(first.id);

    // Only one observation should be in the store.
    const doc = fx.store.load('personal');
    expect(doc.observations).toHaveLength(1);
  });

  it('dedup: different content creates a new observation', () => {
    const first = fx.useCase.save({ title: 'T', content: 'A', scope: 'personal' });
    const second = fx.useCase.save({ title: 'T', content: 'B', scope: 'personal' });
    expect(second.id).not.toBe(first.id);
  });

  it('dedup: soft-deleted observation does not block a new one with same content', () => {
    const obs = fx.useCase.save({ title: 'X', content: 'Y', scope: 'personal' });
    fx.store.softDelete('personal', undefined, obs.id);
    const second = fx.useCase.save({ title: 'X', content: 'Y', scope: 'personal' });
    expect(second.id).not.toBe(obs.id);
  });

  it('generates a default sessionId when none is provided (personal)', () => {
    const obs = fx.useCase.save({ title: 'T', content: 'C', scope: 'personal' });
    expect(obs.sessionId).toBe('manual-global');
  });

  it('generates a default sessionId from projectPath basename (project scope)', () => {
    const obs = fx.useCase.save({
      title: 'T',
      content: 'C',
      projectPath: '/home/user/my-project',
    });
    expect(obs.sessionId).toBe('manual-my-project');
  });

  it('uses the caller-supplied sessionId when provided', () => {
    const obs = fx.useCase.save({
      title: 'T',
      content: 'C',
      scope: 'personal',
      sessionId: 'ses-42',
    });
    expect(obs.sessionId).toBe('ses-42');
  });

  it('propagates optional fields when provided', () => {
    const obs = fx.useCase.save({
      title: 'T',
      content: 'C',
      scope: 'personal',
      topicKey: 'auth',
      toolName: 'mem_save',
      project: '/proj',
    });
    expect(obs.topicKey).toBe('auth');
    expect(obs.toolName).toBe('mem_save');
    expect(obs.project).toBe('/proj');
  });

  it('omits optional fields when not provided (exactOptionalPropertyTypes)', () => {
    const obs = fx.useCase.save({ title: 'T', content: 'C', scope: 'personal' });
    expect('topicKey' in obs).toBe(false);
    expect('toolName' in obs).toBe(false);
    expect('project' in obs).toBe(false);
  });

  // E-DSK-13 #6 — topic_key upsert
  it('upsert: same topicKey updates the existing observation in place', () => {
    const first = fx.useCase.save({
      title: 'Auth v1', content: 'JWT in localStorage', topicKey: 'architecture/auth', scope: 'personal',
    });
    const second = fx.useCase.save({
      title: 'Auth v2', content: 'JWT in httpOnly cookie', topicKey: 'architecture/auth', scope: 'personal',
    });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Auth v2');
    expect(second.content).toBe('JWT in httpOnly cookie');
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);

    const doc = fx.store.load('personal');
    expect(doc.observations).toHaveLength(1);
  });

  it('upsert: different topicKey creates separate observations', () => {
    const a = fx.useCase.save({ title: 'A', content: 'x', topicKey: 'topic/a', scope: 'personal' });
    const b = fx.useCase.save({ title: 'B', content: 'y', topicKey: 'topic/b', scope: 'personal' });
    expect(b.id).not.toBe(a.id);
    expect(fx.store.load('personal').observations).toHaveLength(2);
  });

  it('upsert: a soft-deleted topic does not capture the new save', () => {
    const a = fx.useCase.save({ title: 'A', content: 'x', topicKey: 'topic/a', scope: 'personal' });
    fx.store.softDelete('personal', undefined, a.id);
    const b = fx.useCase.save({ title: 'A2', content: 'x2', topicKey: 'topic/a', scope: 'personal' });
    expect(b.id).not.toBe(a.id);
  });
});

// ── search ────────────────────────────────────────────────────────────────

describe('MemoryUseCase.search', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('returns matching observations', () => {
    fx.useCase.save({ title: 'Postgres decision', content: 'Use PG for storage', scope: 'personal' });
    fx.useCase.save({ title: 'Redis caching', content: 'Use Redis for sessions', scope: 'personal' });

    const hits = fx.useCase.search('postgres', { scope: 'personal' });
    expect(hits).toHaveLength(1);
    expect(expectPresent(hits[0]).observation.title).toBe('Postgres decision');
  });

  it('respects the limit option', () => {
    for (let i = 0; i < 5; i++) {
      fx.useCase.save({ title: `note ${i}`, content: 'text', scope: 'personal' });
    }
    const hits = fx.useCase.search('', { scope: 'personal', limit: 2 });
    expect(hits).toHaveLength(2);
  });

  it('filters by type when specified', () => {
    fx.useCase.save({ title: 'Bug fix', content: 'Fixed null pointer', type: 'bugfix', scope: 'personal' });
    fx.useCase.save({ title: 'Arch note', content: 'Layered arch', type: 'architecture', scope: 'personal' });

    const hits = fx.useCase.search('', { scope: 'personal', type: 'bugfix' });
    expect(hits).toHaveLength(1);
    expect(expectPresent(hits[0]).observation.type).toBe('bugfix');
  });
});

// ── context ───────────────────────────────────────────────────────────────

describe('MemoryUseCase.context', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('returns empty arrays when there are no sessions', () => {
    const ctx = fx.useCase.context({ scope: 'personal' });
    expect(ctx.sessions).toHaveLength(0);
    expect(ctx.recentSummaries).toHaveLength(0);
  });

  it('returns sessions sorted newest-first', () => {
    fx.store.appendSession({ scope: 'personal', project: 'p', directory: '/p', startedAt: 1000 });
    fx.store.appendSession({ scope: 'personal', project: 'p', directory: '/p', startedAt: 3000 });
    fx.store.appendSession({ scope: 'personal', project: 'p', directory: '/p', startedAt: 2000 });

    const ctx = fx.useCase.context({ scope: 'personal' });
    expect(expectPresent(ctx.sessions[0]).startedAt).toBe(3000);
    expect(expectPresent(ctx.sessions[1]).startedAt).toBe(2000);
    expect(expectPresent(ctx.sessions[2]).startedAt).toBe(1000);
  });

  it('returns summaries from sessions that have one', () => {
    fx.store.appendSession({
      scope: 'personal', project: 'p', directory: '/p',
      startedAt: 1000, endedAt: 2000, summary: 'Session A summary',
    });
    fx.store.appendSession({
      scope: 'personal', project: 'p', directory: '/p',
      startedAt: 3000,
      // no summary
    });

    const ctx = fx.useCase.context({ scope: 'personal' });
    expect(ctx.recentSummaries).toHaveLength(1);
    expect(ctx.recentSummaries[0]).toBe('Session A summary');
  });

  it('limits to CONTEXT_SESSION_LIMIT sessions', () => {
    for (let i = 0; i < 15; i++) {
      fx.store.appendSession({ scope: 'personal', project: 'p', directory: '/p', startedAt: i * 1000 });
    }
    const ctx = fx.useCase.context({ scope: 'personal' });
    expect(ctx.sessions.length).toBeLessThanOrEqual(10);
  });

  // E-DSK-13 #5 — auto sessions excluded from the curated feed
  it('excludes auto sessions when includeAuto is false', () => {
    fx.store.appendSession({
      scope: 'personal', project: 'p', directory: '/p',
      startedAt: 2000, summary: 'Agent summary',
    });
    fx.store.appendSession({
      scope: 'personal', project: 'p', directory: '/p',
      startedAt: 3000, summary: 'Auto summary', auto: true,
    });

    const curated = fx.useCase.context({ scope: 'personal', includeAuto: false });
    expect(curated.recentSummaries).toEqual(['Agent summary']);

    const all = fx.useCase.context({ scope: 'personal' });
    expect(all.recentSummaries).toContain('Auto summary');
    expect(all.recentSummaries).toContain('Agent summary');
  });

  it('auto filtering happens before the recency limit (curated survive a burst of auto)', () => {
    fx.store.appendSession({
      scope: 'personal', project: 'p', directory: '/p',
      startedAt: 1, summary: 'Curated old',
    });
    for (let i = 0; i < 15; i++) {
      fx.store.appendSession({
        scope: 'personal', project: 'p', directory: '/p',
        startedAt: 1000 + i, summary: `Auto ${i}`, auto: true,
      });
    }
    const curated = fx.useCase.context({ scope: 'personal', includeAuto: false });
    expect(curated.recentSummaries).toEqual(['Curated old']);
  });
});

describe('MemoryUseCase.sessionSummary auto flag', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('marks the session as auto when requested', () => {
    const ses = fx.useCase.sessionSummary({ content: 'Auto', scope: 'personal', auto: true });
    expect(ses.auto).toBe(true);
  });

  it('omits the auto flag by default', () => {
    const ses = fx.useCase.sessionSummary({ content: 'Manual', scope: 'personal' });
    expect('auto' in ses).toBe(false);
  });
});

// ── sessionSummary ────────────────────────────────────────────────────────

describe('MemoryUseCase.sessionSummary', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('creates a closed session with the summary content', () => {
    const ses = fx.useCase.sessionSummary({
      content: 'Implemented login flow',
      scope: 'personal',
    });
    expect(ses.id).toBeDefined();
    expect(ses.summary).toBe('Implemented login flow');
    expect(ses.endedAt).toBeTypeOf('number');
    expect(ses.startedAt).toBeTypeOf('number');
  });

  it('derives project name from projectPath', () => {
    const ses = fx.useCase.sessionSummary({
      content: 'Done',
      projectPath: '/home/user/my-project',
    });
    expect(ses.project).toBe('my-project');
  });
});

// ── savePrompt ────────────────────────────────────────────────────────────

describe('MemoryUseCase.savePrompt', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('persists a user prompt record', () => {
    const prm = fx.useCase.savePrompt({ content: 'What is the auth flow?', scope: 'personal' });
    expect(prm.id).toBe('prm-1');
    expect(prm.content).toBe('What is the auth flow?');
    expect(prm.createdAt).toBeTypeOf('number');
  });

  it('uses the provided sessionId when given', () => {
    const prm = fx.useCase.savePrompt({
      content: 'Q',
      scope: 'personal',
      sessionId: 'ses-99',
    });
    expect(prm.sessionId).toBe('ses-99');
  });

  it('generates a default sessionId from project scope + projectPath', () => {
    const prm = fx.useCase.savePrompt({
      content: 'Q',
      projectPath: '/home/user/devia',
    });
    expect(prm.sessionId).toBe('manual-devia');
  });

  it('includes project when provided', () => {
    const prm = fx.useCase.savePrompt({
      content: 'Q',
      scope: 'personal',
      project: '/my-proj',
    });
    expect(prm.project).toBe('/my-proj');
  });
});

// ── currentProject ────────────────────────────────────────────────────────

describe('MemoryUseCase.currentProject', () => {
  it('returns basename of the provided path', () => {
    const uc = new MemoryUseCase(new MemoryStore(() => '/unused'));
    const result = uc.currentProject('/home/user/my-project');
    expect(result.project).toBe('my-project');
    expect(result.source).toBe('path-basename');
  });

  it('strips trailing slashes', () => {
    const uc = new MemoryUseCase(new MemoryStore(() => '/unused'));
    expect(uc.currentProject('/home/user/my-project/').project).toBe('my-project');
  });

  it('returns unknown when no path is provided', () => {
    const uc = new MemoryUseCase(new MemoryStore(() => '/unused'));
    const result = uc.currentProject();
    expect(result.project).toBe('unknown');
    expect(result.source).toBe('path-basename');
  });
});

// ── getObservation ────────────────────────────────────────────────────────

describe('MemoryUseCase.getObservation', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('returns the observation by id', () => {
    const obs = fx.useCase.save({ title: 'T', content: 'C', scope: 'personal' });
    const found = fx.useCase.getObservation(obs.id, { scope: 'personal' });
    expect(expectPresent(found).id).toBe(obs.id);
  });

  it('returns undefined for an unknown id', () => {
    expect(fx.useCase.getObservation('obs-999', { scope: 'personal' })).toBeUndefined();
  });
});

// ── recall (E-DSK-13 #314) ──────────────────────────────────────────────────

describe('MemoryUseCase.recall', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('returns observations relevant to the query plus recent summaries', () => {
    fx.useCase.save({ title: 'Postgres decision', content: 'Use PG for storage', type: 'decision', scope: 'personal' });
    fx.useCase.save({ title: 'Redis caching', content: 'Use Redis for sessions', scope: 'personal' });
    fx.store.appendSession({ scope: 'personal', project: 'p', directory: '/p', startedAt: 1000, summary: 'Recent work' });

    const r = fx.useCase.recall({ query: 'postgres storage', scope: 'personal' });
    const titles = r.observations.map((o) => o.title);
    expect(titles).toContain('Postgres decision');
    expect(titles).not.toContain('Redis caching');
    expect(r.summaries).toContain('Recent work');
  });

  it('respects observationLimit and summaryLimit', () => {
    for (let i = 0; i < 5; i++) fx.useCase.save({ title: `note ${i}`, content: 'text', scope: 'personal' });
    for (let i = 0; i < 5; i++) {
      fx.store.appendSession({ scope: 'personal', project: 'p', directory: '/p', startedAt: i * 1000, summary: `S${i}` });
    }
    const r = fx.useCase.recall({ query: '', scope: 'personal', observationLimit: 2, summaryLimit: 1 });
    expect(r.observations.length).toBeLessThanOrEqual(2);
    expect(r.summaries.length).toBeLessThanOrEqual(1);
  });

  it('excludes auto-captured summaries (reuses includeAuto:false)', () => {
    fx.store.appendSession({ scope: 'personal', project: 'p', directory: '/p', startedAt: 2000, summary: 'Curated' });
    fx.store.appendSession({ scope: 'personal', project: 'p', directory: '/p', startedAt: 3000, summary: 'Auto one', auto: true });
    const r = fx.useCase.recall({ query: '', scope: 'personal' });
    expect(r.summaries).toContain('Curated');
    expect(r.summaries).not.toContain('Auto one');
  });
});

// ── sessionSummary upsert (E-DSK-13 #318) ───────────────────────────────────

describe('MemoryUseCase.sessionSummary upsert', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('keeps ONE record per sessionId across calls, preserving startedAt', () => {
    const s1 = fx.useCase.sessionSummary({ content: 'turn 1', sessionId: 'run-1', startedAt: 1000, scope: 'personal' });
    const s2 = fx.useCase.sessionSummary({ content: 'turn 2', sessionId: 'run-1', startedAt: 5000, scope: 'personal' });
    expect(s2.id).toBe(s1.id);
    expect(s2.summary).toBe('turn 2');
    expect(s2.startedAt).toBe(1000); // first-seen start is preserved
    expect(s2.endedAt).toBeTypeOf('number');
    expect(fx.store.load('personal').sessions.filter((x) => x.sessionId === 'run-1')).toHaveLength(1);
  });

  it('appends a separate record for a different sessionId', () => {
    fx.useCase.sessionSummary({ content: 'a', sessionId: 'run-1', scope: 'personal' });
    fx.useCase.sessionSummary({ content: 'b', sessionId: 'run-2', scope: 'personal' });
    expect(fx.store.load('personal').sessions).toHaveLength(2);
  });

  it('falls back to append (no upsert) when no sessionId is given', () => {
    fx.useCase.sessionSummary({ content: 'x', scope: 'personal' });
    fx.useCase.sessionSummary({ content: 'y', scope: 'personal' });
    expect(fx.store.load('personal').sessions).toHaveLength(2);
  });
});

// ── store pruning / size cap (E-DSK-13 #316) ────────────────────────────────

describe('MemoryStore size caps', () => {
  it('caps observations to the configured limit, keeping the most recent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mem-cap-'));
    try {
      const store = new MemoryStore(() => dir, { observations: 3 });
      const uc = new MemoryUseCase(store);
      for (let i = 0; i < 7; i++) uc.save({ title: `t${i}`, content: `c${i}`, scope: 'personal' });
      const titles = store.load('personal').observations.map((o) => o.title);
      expect(titles).toHaveLength(3);
      expect(titles).toContain('t6'); // newest survive
      expect(titles).not.toContain('t0'); // oldest pruned
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps prompts and sessions independently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mem-cap2-'));
    try {
      const store = new MemoryStore(() => dir, { prompts: 2, sessions: 2 });
      const uc = new MemoryUseCase(store);
      for (let i = 0; i < 5; i++) uc.savePrompt({ content: `p${i}`, scope: 'personal' });
      for (let i = 0; i < 5; i++) {
        store.appendSession({ scope: 'personal', project: 'p', directory: '/p', startedAt: i });
      }
      const doc = store.load('personal');
      expect(doc.prompts).toHaveLength(2);
      expect(doc.sessions).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // E-DSK-13 #320 — pin/forget
  it('setPinned toggles the pinned flag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mem-pin-'));
    try {
      const uc = new MemoryUseCase(new MemoryStore(() => dir));
      const o = uc.save({ title: 'x', content: 'y', scope: 'personal' });
      expect(o.pinned).toBeUndefined();
      expect(uc.setPinned(o.id, true, { scope: 'personal' })?.pinned).toBe(true);
      expect(uc.setPinned(o.id, false, { scope: 'personal' })?.pinned).toBeFalsy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pinned observations survive pruning even over the cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mem-pinkeep-'));
    try {
      const store = new MemoryStore(() => dir, { observations: 2 });
      const uc = new MemoryUseCase(store);
      const keep = uc.save({ title: 'keep me', content: 'c', scope: 'personal' });
      uc.setPinned(keep.id, true, { scope: 'personal' });
      for (let i = 0; i < 6; i++) uc.save({ title: `t${i}`, content: `c${i}`, scope: 'personal' });
      expect(store.load('personal').observations.map((o) => o.title)).toContain('keep me');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clear wipes the scope to empty (observations, prompts, sessions)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mem-clear-'));
    try {
      const store = new MemoryStore(() => dir);
      const uc = new MemoryUseCase(store);
      uc.save({ title: 'a', content: 'b', scope: 'personal' });
      uc.savePrompt({ content: 'p', scope: 'personal' });
      store.appendSession({ scope: 'personal', project: 'p', directory: '/p', startedAt: 1 });
      uc.clear({ scope: 'personal' });
      const doc = store.load('personal');
      expect(doc.observations).toHaveLength(0);
      expect(doc.prompts).toHaveLength(0);
      expect(doc.sessions).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
