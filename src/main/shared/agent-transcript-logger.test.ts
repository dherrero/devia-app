import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RunId } from '../../shared/domain/agent';
import type { AgentEvent } from '../../shared/domain/agent-event';
import type { RunGatewayEvent } from './run-gateway';
import { AgentTranscriptLogger, purgeOldTranscripts } from './agent-transcript-logger';

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-transcript-'));

const PROJECT = '/work/devia';
const rid = (s: string): RunId => s as RunId;

/** Wrap an AgentEvent as the serialized `output` line the gateway emits. */
const out = (event: AgentEvent): RunGatewayEvent => ({
  type: 'output',
  project: PROJECT,
  line: JSON.stringify(event),
});

const sessionFile = (dir: string): string => {
  const file = fs.readdirSync(dir).find((f) => f.startsWith('session-') && f.endsWith('.md'));
  if (!file) throw new Error('no session file');
  return path.join(dir, file);
};

describe('AgentTranscriptLogger', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpRoot();
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  const feed = (logger: AgentTranscriptLogger): void => {
    logger.onEvent({ type: 'start', project: PROJECT, runId: rid('run-1'), agentId: 'claude-code' });
    logger.onEvent(out({ type: 'status', label: 'Pensando', model: 'claude-opus-4-8' }));
    logger.onEvent(out({ type: 'thinking_delta', delta: 'Voy a ' }));
    logger.onEvent(out({ type: 'thinking_delta', delta: 'revisar el bug.' }));
    logger.onEvent(out({ type: 'text_delta', delta: 'He encontrado ' }));
    logger.onEvent(out({ type: 'text_delta', delta: 'el problema.' }));
    logger.onEvent(out({ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.ts' } }));
    logger.onEvent(out({ type: 'tool_result', toolUseId: 't1', content: 'line 1', isError: false }));
    logger.onEvent(out({ type: 'usage', inputTokens: 100, outputTokens: 42, costUsd: 0.03 }));
    logger.onEvent(out({ type: 'turn_end', stopReason: 'end_turn' }));
    logger.onEvent({ type: 'end', project: PROJECT, runId: rid('run-1'), code: 0 });
  };

  it('writes a readable Markdown transcript with agent, model, message and tools', () => {
    const logger = new AgentTranscriptLogger({
      dir,
      startedAt: new Date('2026-06-06T12:00:00Z'),
      modelFor: () => 'claude-opus-4-8',
    });
    feed(logger);

    const md = fs.readFileSync(sessionFile(dir), 'utf8');
    // Header marks the run, agent and model.
    expect(md).toContain('## ▶ run-1 · claude-code · claude-opus-4-8');
    expect(md).toContain(`proyecto: ${PROJECT}`);
    // Thinking + assistant reply are buffered and written whole.
    expect(md).toContain('### 🧠 Thinking\nVoy a revisar el bug.');
    expect(md).toContain('### 💬 Respuesta\nHe encontrado el problema.');
    // Tool call + result.
    expect(md).toContain('### 🔧 Tool: Read');
    expect(md).toContain('"file": "a.ts"');
    expect(md).toContain('→ Resultado');
    expect(md).toContain('line 1');
    // Usage + end.
    expect(md).toContain('out 42');
    expect(md).toContain('$0.0300');
    expect(md).toContain('### ✅ Fin · succeeded');
  });

  it('mirrors the session to latest.md and resets it per session', () => {
    new AgentTranscriptLogger({ dir, startedAt: new Date('2026-06-06T12:00:00Z') }).onEvent({
      type: 'start',
      project: PROJECT,
      runId: rid('old-run'),
      agentId: 'claude-code',
    });
    let latest = fs.readFileSync(path.join(dir, 'latest.md'), 'utf8');
    expect(latest).toContain('old-run');

    // A new session truncates latest.md — it must reflect only the new run.
    const next = new AgentTranscriptLogger({ dir, startedAt: new Date('2026-06-06T13:00:00Z') });
    next.onEvent({ type: 'start', project: PROJECT, runId: rid('new-run'), agentId: 'codex' });
    latest = fs.readFileSync(path.join(dir, 'latest.md'), 'utf8');
    expect(latest).toContain('new-run');
    expect(latest).not.toContain('old-run');
  });

  it('falls back to the config model when status carries none', () => {
    const logger = new AgentTranscriptLogger({
      dir,
      startedAt: new Date('2026-06-06T12:00:00Z'),
      modelFor: (id) => (id === 'codex' ? 'gpt-5' : undefined),
    });
    logger.onEvent({ type: 'start', project: PROJECT, runId: rid('r'), agentId: 'codex' });
    expect(fs.readFileSync(sessionFile(dir), 'utf8')).toContain('codex · gpt-5');
  });

  it('renders an error event', () => {
    const logger = new AgentTranscriptLogger({ dir, startedAt: new Date('2026-06-06T12:00:00Z') });
    logger.onEvent({ type: 'start', project: PROJECT, runId: rid('r'), agentId: 'claude-code' });
    logger.onEvent(out({ type: 'error', message: 'boom', classification: 'crash' }));
    const md = fs.readFileSync(sessionFile(dir), 'utf8');
    expect(md).toContain('### ⛔ Error (crash)');
    expect(md).toContain('boom');
  });

  it('survives a non-JSON output line as a raw block', () => {
    const logger = new AgentTranscriptLogger({ dir, startedAt: new Date('2026-06-06T12:00:00Z') });
    logger.onEvent({ type: 'start', project: PROJECT, runId: rid('r'), agentId: 'claude-code' });
    logger.onEvent({ type: 'output', project: PROJECT, line: 'not-json' });
    expect(fs.readFileSync(sessionFile(dir), 'utf8')).toContain('not-json');
  });

  it('does not throw when output arrives before start', () => {
    const logger = new AgentTranscriptLogger({ dir, startedAt: new Date('2026-06-06T12:00:00Z') });
    expect(() => logger.onEvent(out({ type: 'text_delta', delta: 'orphan' }))).not.toThrow();
  });

  it('renders MCP tool calls as "MCP: server/tool" and names their results', () => {
    const logger = new AgentTranscriptLogger({ dir, startedAt: new Date('2026-06-06T12:00:00Z') });
    logger.onEvent({ type: 'start', project: PROJECT, runId: rid('r'), agentId: 'codex' });
    logger.onEvent(out({ type: 'tool_use', id: 'm1', name: 'mcp__devia-kanban__kanban_list', input: {} }));
    logger.onEvent(out({ type: 'tool_result', toolUseId: 'm1', content: '{"specs":[]}', isError: false }));
    const md = fs.readFileSync(sessionFile(dir), 'utf8');
    expect(md).toContain('### 🔧 MCP: devia-kanban/kanban_list');
    expect(md).toContain('→ Resultado (MCP: devia-kanban/kanban_list)');
  });

  it('labels results and errors with their tool name', () => {
    const logger = new AgentTranscriptLogger({ dir, startedAt: new Date('2026-06-06T12:00:00Z') });
    logger.onEvent({ type: 'start', project: PROJECT, runId: rid('r'), agentId: 'codex' });
    logger.onEvent(out({ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }));
    logger.onEvent(out({ type: 'tool_result', toolUseId: 'b1', content: 'denied', isError: true }));
    const md = fs.readFileSync(sessionFile(dir), 'utf8');
    expect(md).toContain('### 🔧 Tool: Bash');
    expect(md).toContain('⚠️ Error del tool (Tool: Bash)');
  });

  it('truncates oversized tool results', () => {
    const logger = new AgentTranscriptLogger({ dir, startedAt: new Date('2026-06-06T12:00:00Z') });
    logger.onEvent({ type: 'start', project: PROJECT, runId: rid('r'), agentId: 'codex' });
    logger.onEvent(out({ type: 'tool_use', id: 'b1', name: 'Read', input: { file: 'big.md' } }));
    const huge = 'x'.repeat(10_000);
    logger.onEvent(out({ type: 'tool_result', toolUseId: 'b1', content: huge, isError: false }));
    const md = fs.readFileSync(sessionFile(dir), 'utf8');
    expect(md).toContain('… (truncado, 10000 chars)');
    expect(md).not.toContain(huge);
  });

  it('skips errored tool results with an empty message', () => {
    const logger = new AgentTranscriptLogger({ dir, startedAt: new Date('2026-06-06T12:00:00Z') });
    logger.onEvent({ type: 'start', project: PROJECT, runId: rid('r'), agentId: 'codex' });
    logger.onEvent(out({ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }));
    logger.onEvent(out({ type: 'tool_result', toolUseId: 'b1', content: '  ', isError: true }));
    const md = fs.readFileSync(sessionFile(dir), 'utf8');
    expect(md).not.toContain('⚠️ Error del tool');
  });
});

describe('purgeOldTranscripts', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpRoot();
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  it('removes session files older than 7 days and keeps recent ones', () => {
    const oldFile = path.join(dir, 'session-old.md');
    const newFile = path.join(dir, 'session-new.md');
    fs.writeFileSync(oldFile, '#');
    fs.writeFileSync(newFile, '#');
    const now = Date.now();
    const eightDaysAgo = (now - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    purgeOldTranscripts({ dir, now: () => new Date(now) });

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  it('leaves latest.md untouched and does nothing when the dir is missing', () => {
    fs.writeFileSync(path.join(dir, 'latest.md'), '#');
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(dir, 'latest.md'), old, old);
    purgeOldTranscripts({ dir });
    expect(fs.existsSync(path.join(dir, 'latest.md'))).toBe(true);
    expect(() => purgeOldTranscripts({ dir: path.join(dir, 'missing') })).not.toThrow();
  });
});
