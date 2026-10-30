import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryStore } from '../infrastructure/memory-store';
import { MemoryUseCase } from '../application/memory.use-case';
import { callMemoryTool, MEMORY_TOOLS } from './memory-tools';
import type { MemoryToolDeps } from './memory-tools';

// ── fixtures ──────────────────────────────────────────────────────────────

function setup() {
  const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mem-tools-'));
  const store = new MemoryStore(() => deviaDir);
  const useCase = new MemoryUseCase(store);
  const projectPath = '/home/user/test-project';
  const deps: MemoryToolDeps = { useCase, store, projectPath };
  const cleanup = () => fs.rmSync(deviaDir, { recursive: true, force: true });
  return { deviaDir, store, useCase, deps, projectPath, cleanup };
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

// ── tool list ─────────────────────────────────────────────────────────────

describe('MEMORY_TOOLS', () => {
  it('contains all expected mem_* tools', () => {
    const names = MEMORY_TOOLS.map((t) => t.name);
    expect(names).toContain('mem_save');
    expect(names).toContain('mem_search');
    expect(names).toContain('mem_context');
    expect(names).toContain('mem_session_summary');
    expect(names).toContain('mem_get_observation');
    expect(names).toContain('mem_save_prompt');
    expect(names).toContain('mem_current_project');
  });

  it('each tool has name, description, and inputSchema', () => {
    for (const tool of MEMORY_TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('mem_save requires title', () => {
    const saveTool = MEMORY_TOOLS.find((t) => t.name === 'mem_save');
    expect(saveTool?.inputSchema['required']).toContain('title');
  });

  it('mem_search requires query', () => {
    const searchTool = MEMORY_TOOLS.find((t) => t.name === 'mem_search');
    expect(searchTool?.inputSchema['required']).toContain('query');
  });
});

// ── mem_save ──────────────────────────────────────────────────────────────

describe('callMemoryTool: mem_save', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('saves an observation and returns a confirmation string', () => {
    const result = callMemoryTool(fx.deps, 'mem_save', {
      title: 'Use JSON for persistence',
      content: 'Avoids native deps',
    });
    expect(result).toMatch(/^Saved observation obs-1: "Use JSON for persistence"\.$/);
  });

  it('maps snake_case topic_key to topicKey', () => {
    callMemoryTool(fx.deps, 'mem_save', {
      title: 'Auth decision',
      content: 'JWT',
      topic_key: 'auth',
    });
    const doc = fx.store.load('project', fx.projectPath);
    expect(expectPresent(doc.observations[0]).topicKey).toBe('auth');
  });

  it('maps snake_case session_id to sessionId', () => {
    callMemoryTool(fx.deps, 'mem_save', {
      title: 'T',
      content: 'C',
      session_id: 'ses-42',
    });
    const doc = fx.store.load('project', fx.projectPath);
    expect(expectPresent(doc.observations[0]).sessionId).toBe('ses-42');
  });

  it('throws when title is missing', () => {
    expect(() => callMemoryTool(fx.deps, 'mem_save', { content: 'no title' })).toThrow('title');
  });

  it('stores tool_name as mem_save on the observation', () => {
    callMemoryTool(fx.deps, 'mem_save', { title: 'T', content: 'C' });
    const doc = fx.store.load('project', fx.projectPath);
    expect(expectPresent(doc.observations[0]).toolName).toBe('mem_save');
  });
});

// ── mem_search ────────────────────────────────────────────────────────────

describe('callMemoryTool: mem_search', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('returns JSON array of search results', async () => {
    callMemoryTool(fx.deps, 'mem_save', { title: 'Postgres decision', content: 'Use PG' });
    callMemoryTool(fx.deps, 'mem_save', { title: 'Redis caching', content: 'Use Redis' });

    const raw = await callMemoryTool(fx.deps, 'mem_search', { query: 'postgres' });
    const parsed = JSON.parse(raw) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as { title: string }).title).toBe('Postgres decision');
  });

  it('returns empty array for no matches', async () => {
    const raw = await callMemoryTool(fx.deps, 'mem_search', { query: 'nonexistent term xyz' });
    expect(JSON.parse(raw)).toEqual([]);
  });

  it('throws when query is missing', () => {
    expect(() => callMemoryTool(fx.deps, 'mem_search', {})).toThrow('query');
  });

  it('respects limit param', async () => {
    for (let i = 0; i < 5; i++) {
      callMemoryTool(fx.deps, 'mem_save', { title: `note ${i}`, content: 'text' });
    }
    const raw = await callMemoryTool(fx.deps, 'mem_search', { query: '', limit: 2 });
    expect((JSON.parse(raw) as unknown[]).length).toBe(2);
  });
});

// ── mem_context ───────────────────────────────────────────────────────────

describe('callMemoryTool: mem_context', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('returns JSON with sessions and recentSummaries arrays', async () => {
    const raw = await callMemoryTool(fx.deps, 'mem_context', {});
    const ctx = JSON.parse(raw) as { sessions: unknown[]; recentSummaries: unknown[] };
    expect(Array.isArray(ctx.sessions)).toBe(true);
    expect(Array.isArray(ctx.recentSummaries)).toBe(true);
  });

  it('includes summaries after session_summary is saved', async () => {
    callMemoryTool(fx.deps, 'mem_session_summary', { content: 'Done with login' });
    const raw = await callMemoryTool(fx.deps, 'mem_context', {});
    const ctx = JSON.parse(raw) as { recentSummaries: string[] };
    expect(ctx.recentSummaries).toContain('Done with login');
  });
});

// ── mem_session_summary ───────────────────────────────────────────────────

describe('callMemoryTool: mem_session_summary', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('saves a session and returns a confirmation', () => {
    const result = callMemoryTool(fx.deps, 'mem_session_summary', {
      content: 'Implemented login flow',
    });
    expect(result).toMatch(/Session summary saved \(ses-\d+\)\./);
  });

  it('throws when content is missing', () => {
    expect(() => callMemoryTool(fx.deps, 'mem_session_summary', {})).toThrow('content');
  });
});

// ── mem_get_observation ───────────────────────────────────────────────────

describe('callMemoryTool: mem_get_observation', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('returns JSON observation for known id', async () => {
    callMemoryTool(fx.deps, 'mem_save', { title: 'Auth', content: 'JWT approach' });
    const raw = await callMemoryTool(fx.deps, 'mem_get_observation', { id: 'obs-1' });
    const obs = JSON.parse(raw) as { id: string; title: string };
    expect(obs.id).toBe('obs-1');
    expect(obs.title).toBe('Auth');
  });

  it('throws for unknown id', () => {
    expect(() => callMemoryTool(fx.deps, 'mem_get_observation', { id: 'obs-999' })).toThrow('not found');
  });

  it('throws when id is missing', () => {
    expect(() => callMemoryTool(fx.deps, 'mem_get_observation', {})).toThrow('id');
  });
});

// ── mem_save_prompt ───────────────────────────────────────────────────────

describe('callMemoryTool: mem_save_prompt', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('saves a prompt and returns confirmation', () => {
    const result = callMemoryTool(fx.deps, 'mem_save_prompt', { content: 'How does auth work?' });
    expect(result).toMatch(/Prompt saved \(prm-\d+\)\./);
  });

  it('throws when content is missing', () => {
    expect(() => callMemoryTool(fx.deps, 'mem_save_prompt', {})).toThrow('content');
  });
});

// ── mem_current_project ───────────────────────────────────────────────────

describe('callMemoryTool: mem_current_project', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('returns JSON with project and source', async () => {
    const raw = await callMemoryTool(fx.deps, 'mem_current_project', {});
    const result = JSON.parse(raw) as { project: string; source: string };
    expect(result.project).toBe('test-project');
    expect(result.source).toBe('path-basename');
  });
});

// ── unknown tool ──────────────────────────────────────────────────────────

describe('callMemoryTool: agentId stamping (S-2 F1.1)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  function depsWithAgent(agentId: string): MemoryToolDeps {
    return { ...ctx.deps, agentId };
  }

  it('mem_save stamps the active agent id on the observation', async () => {
    await callMemoryTool(depsWithAgent('codex'), 'mem_save', { title: 'Decisión X', content: 'cuerpo' });
    const doc = ctx.store.load('project', ctx.projectPath);
    expect(doc.observations[0]?.agentId).toBe('codex');
  });

  it('mem_session_summary stamps the active agent id on the session', async () => {
    await callMemoryTool(depsWithAgent('claude'), 'mem_session_summary', { content: 'resumen', session_id: 'run-1' });
    const doc = ctx.store.load('project', ctx.projectPath);
    expect(doc.sessions[0]?.agentId).toBe('claude');
  });

  it('mem_save_prompt stamps the active agent id on the prompt record', async () => {
    await callMemoryTool(depsWithAgent('gemini'), 'mem_save_prompt', { content: 'haz X' });
    const doc = ctx.store.load('project', ctx.projectPath);
    expect(doc.prompts[0]?.agentId).toBe('gemini');
  });

  it('writes carry no agentId when the env var is absent', async () => {
    await callMemoryTool(ctx.deps, 'mem_save', { title: 'Sin agente', content: 'x' });
    const doc = ctx.store.load('project', ctx.projectPath);
    expect('agentId' in (doc.observations[0] ?? {})).toBe(false);
  });
});

describe('MemoryUseCase.recentSessionSummary (S-2 F3.4)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.cleanup());

  it('returns the fresh rich summary recorded by the requested agent', () => {
    ctx.useCase.sessionSummary({
      content: 'Resumen rico de traspaso', sessionId: 'run-1', agentId: 'codex', projectPath: ctx.projectPath,
    });

    const hit = ctx.useCase.recentSessionSummary({
      sessionId: 'run-1', agentId: 'codex', maxAgeMs: 15 * 60_000, projectPath: ctx.projectPath,
    });
    expect(hit).toBe('Resumen rico de traspaso');
  });

  it('misses on wrong agent, wrong session, staleness, or handoff records', () => {
    ctx.useCase.sessionSummary({
      content: 'viejo', sessionId: 'run-1', agentId: 'codex', projectPath: ctx.projectPath,
    });
    ctx.useCase.sessionSummary({
      content: 'registro handoff', sessionId: 'run-2', agentId: 'claude', kind: 'handoff', projectPath: ctx.projectPath,
    });

    expect(ctx.useCase.recentSessionSummary({
      sessionId: 'run-1', agentId: 'claude', maxAgeMs: 15 * 60_000, projectPath: ctx.projectPath,
    })).toBeNull();
    expect(ctx.useCase.recentSessionSummary({
      sessionId: 'otro', agentId: 'codex', maxAgeMs: 15 * 60_000, projectPath: ctx.projectPath,
    })).toBeNull();
    expect(ctx.useCase.recentSessionSummary({
      sessionId: 'run-1', agentId: 'codex', maxAgeMs: -1, projectPath: ctx.projectPath,
    })).toBeNull();
    expect(ctx.useCase.recentSessionSummary({
      sessionId: 'run-2', agentId: 'claude', maxAgeMs: 15 * 60_000, projectPath: ctx.projectPath,
    })).toBeNull();
  });
});

describe('callMemoryTool: unknown tool', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('throws for an unrecognised tool name', () => {
    expect(() => callMemoryTool(fx.deps, 'mem_does_not_exist', {})).toThrow('Unknown tool');
  });
});
