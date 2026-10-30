import { describe, it, expect, beforeEach } from 'vitest';
import type { ConfigRepository, SessionStore } from '../../shared/ports';
import type { PersistedSession } from '../../../shared/domain/session';
import type { SessionTranscriptRef } from '../../../shared/domain/agent-transcript';
import type { ImportSource, SessionTranscriptReader } from './domain/ports';
import { ScanSessionsUseCase } from './application/scan-sessions.use-case';
import { ImportSessionsUseCase } from './application/import-sessions.use-case';
import { claudeParser, codexParser } from './parsers';

const WS = '/ws';

function fakeConfig(workspaceRoot: string | undefined = WS): ConfigRepository {
  return {
    get: () => ({ workspaceRoot }) as ReturnType<ConfigRepository['get']>,
    set: (p) => p as ReturnType<ConfigRepository['set']>,
    reload: () => ({}) as ReturnType<ConfigRepository['reload']>,
    hasWorkspace: () => !!workspaceRoot,
    configPath: () => '',
    deviaDir: () => '/devia',
  };
}

class FakeSessionStore implements SessionStore {
  saved = new Map<string, PersistedSession>();
  newSessionId() { return 'x'; }
  isValidSessionId(id: string | null | undefined): id is string { return typeof id === 'string'; }
  save(projectPath: string, session: PersistedSession) { this.saved.set(`${projectPath}::${session.id}`, session); }
  load(projectPath: string, sessionId: string) { return this.saved.get(`${projectPath}::${sessionId}`) ?? null; }
  list(projectPath: string) {
    return [...this.saved.entries()]
      .filter(([k]) => k.startsWith(`${projectPath}::`))
      .map(([, v]) => v);
  }
  deleteOne() { /* unused */ }
  deleteProjectSessions() { /* unused */ }
  collectAllStats() { return []; }
}

/** Minimal one-user-one-assistant Claude transcript for a given cwd/session. */
function claudeTranscript(sessionId: string, cwd: string): string {
  return [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId, cwd, isSidechain: false,
      timestamp: '2026-06-01T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hola' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId, cwd, isSidechain: false,
      timestamp: '2026-06-01T10:00:01.000Z', message: { id: 'm', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hey' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
  ].join('\n');
}

/** Minimal Codex rollout for a given uuid/cwd. */
function codexRollout(uuid: string, cwd: string): string {
  return [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-06-02T09:00:00.000Z', payload: { id: uuid, cwd, timestamp: '2026-06-02T09:00:00.000Z' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-06-02T09:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'resume el repo' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-06-02T09:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'claro' }] } }),
  ].join('\n');
}

class FakeReader implements SessionTranscriptReader {
  constructor(readonly agentId: string, private readonly files: Record<string, string>) {}
  available() { return Object.keys(this.files).length > 0; }
  listTranscripts(): SessionTranscriptRef[] {
    return Object.keys(this.files).map((filePath) => ({ nativeId: filePath.replace(/\.jsonl$/, '').split('/').pop()!, filePath }));
  }
  read(filePath: string) { return this.files[filePath] ?? null; }
}

const CLAUDE_IN = '3c8ebbae-a156-40ce-b099-50c88babeab9';
const CLAUDE_OUT = '11111111-1111-4111-8111-111111111111';
const CODEX_IN = '019ee68f-a940-7910-9a10-b8d68dd5dd09';

function claudeSource(files: Record<string, string>): ImportSource {
  return { reader: new FakeReader('claude', files), parser: claudeParser };
}
function codexSource(files: Record<string, string>): ImportSource {
  return { reader: new FakeReader('codex', files), parser: codexParser };
}

describe('ScanSessionsUseCase', () => {
  it('lists only sessions whose cwd is inside the workspace, grouped by agent → project', () => {
    const sources = [
      claudeSource({
        [`/c/${CLAUDE_IN}.jsonl`]: claudeTranscript(CLAUDE_IN, '/ws/Eviatech/devia'),
        [`/c/${CLAUDE_OUT}.jsonl`]: claudeTranscript(CLAUDE_OUT, '/elsewhere/repo'),
      }),
      codexSource({ [`/x/${CODEX_IN}.jsonl`]: codexRollout(CODEX_IN, '/ws/Eviatech/devia') }),
    ];
    const scan = new ScanSessionsUseCase({ config: fakeConfig(), sessions: new FakeSessionStore(), sources });
    const agents = scan.execute();
    expect(agents.map((a) => a.agentId)).toEqual(['claude', 'codex']);
    const claude = agents.find((a) => a.agentId === 'claude')!;
    expect(claude.projects).toHaveLength(1);
    expect(claude.projects[0]?.projectPath).toBe('Eviatech/devia');
    expect(claude.projects[0]?.sessions[0]).toMatchObject({ sessionId: CLAUDE_IN, resumable: true, alreadyImported: false });
    const codex = agents.find((a) => a.agentId === 'codex')!;
    expect(codex.projects[0]?.sessions[0]).toMatchObject({ agentId: 'codex', sessionId: CODEX_IN, resumable: true });
  });

  it('flags alreadyImported when Devia owns the conversation under its own file id', () => {
    const store = new FakeSessionStore();
    store.save('Eviatech/devia', { id: 'devia-random', project: 'Eviatech/devia', createdAt: 1, updatedAt: 1, messages: [], agentSessionId: CLAUDE_IN });
    const sources = [claudeSource({ [`/c/${CLAUDE_IN}.jsonl`]: claudeTranscript(CLAUDE_IN, '/ws/Eviatech/devia') })];
    const scan = new ScanSessionsUseCase({ config: fakeConfig(), sessions: store, sources });
    expect(scan.execute()[0]?.projects[0]?.sessions[0]?.alreadyImported).toBe(true);
  });

  it('returns [] when no workspace is configured', () => {
    const sources = [claudeSource({ [`/c/${CLAUDE_IN}.jsonl`]: claudeTranscript(CLAUDE_IN, '/ws/x') })];
    expect(new ScanSessionsUseCase({ config: fakeConfig(''), sessions: new FakeSessionStore(), sources }).execute()).toEqual([]);
  });
});

describe('ImportSessionsUseCase', () => {
  let store: FakeSessionStore;
  let sources: ImportSource[];
  beforeEach(() => {
    store = new FakeSessionStore();
    sources = [
      claudeSource({ [`/c/${CLAUDE_IN}.jsonl`]: claudeTranscript(CLAUDE_IN, '/ws/Eviatech/devia') }),
      codexSource({ [`/x/${CODEX_IN}.jsonl`]: codexRollout(CODEX_IN, '/ws/Eviatech/devia') }),
    ];
  });

  it('imports a Claude session stamping id + agentId=claude + agentSessionId for native resume', () => {
    const uc = new ImportSessionsUseCase({ config: fakeConfig(), sessions: store, sources });
    const summary = uc.execute([{ agentId: 'claude', projectPath: 'Eviatech/devia', sessionId: CLAUDE_IN }]);
    expect(summary).toEqual({ imported: 1, skipped: 0, failed: 0 });
    const saved = store.load('Eviatech/devia', CLAUDE_IN)!;
    expect(saved).toMatchObject({ id: CLAUDE_IN, agentId: 'claude', agentSessionId: CLAUDE_IN });
    expect(saved.stats).toBeDefined();
  });

  it('imports a Codex rollout stamped agentId=codex + agentSessionId (= rollout uuid)', () => {
    const uc = new ImportSessionsUseCase({ config: fakeConfig(), sessions: store, sources });
    const summary = uc.execute([{ agentId: 'codex', projectPath: 'Eviatech/devia', sessionId: CODEX_IN }]);
    expect(summary).toEqual({ imported: 1, skipped: 0, failed: 0 });
    const saved = store.load('Eviatech/devia', CODEX_IN)!;
    expect(saved).toMatchObject({ id: CODEX_IN, agentId: 'codex', agentSessionId: CODEX_IN });
  });

  it('skips an already-imported session unless force', () => {
    const uc = new ImportSessionsUseCase({ config: fakeConfig(), sessions: store, sources });
    uc.execute([{ agentId: 'codex', projectPath: 'Eviatech/devia', sessionId: CODEX_IN }]);
    expect(uc.execute([{ agentId: 'codex', projectPath: 'Eviatech/devia', sessionId: CODEX_IN }]))
      .toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(uc.execute([{ agentId: 'codex', projectPath: 'Eviatech/devia', sessionId: CODEX_IN }], { force: true }))
      .toEqual({ imported: 1, skipped: 0, failed: 0 });
  });

  it('counts failed for an unknown agent id', () => {
    const uc = new ImportSessionsUseCase({ config: fakeConfig(), sessions: store, sources });
    expect(uc.execute([{ agentId: 'nope', projectPath: 'Eviatech/devia', sessionId: CLAUDE_IN }]))
      .toEqual({ imported: 0, skipped: 0, failed: 1 });
  });

  it('counts failed when the project path does not match the transcript cwd', () => {
    const uc = new ImportSessionsUseCase({ config: fakeConfig(), sessions: store, sources });
    expect(uc.execute([{ agentId: 'claude', projectPath: 'wrong/path', sessionId: CLAUDE_IN }]))
      .toEqual({ imported: 0, skipped: 0, failed: 1 });
  });
});
