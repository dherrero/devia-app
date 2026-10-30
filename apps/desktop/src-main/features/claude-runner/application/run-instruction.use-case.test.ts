/**
 * REV-AGENT-CORE-012 — Use-case-level tests for run lifecycle.
 *
 * Exercises `RunInstructionUseCase` end-to-end with in-memory fakes for every
 * injected port. Covers:
 *
 *   FR1 happy path:    prompt → spawn → text → tool_use → tool_result → done.
 *   FR2 question OK:   AskUserQuestion tool_use → answer → no kill.
 *   FR3 question TO:   AskUserQuestion tool_use → 5 min timer fires → kill('question_timeout').
 *   FR4 audit log:     each tool_use produces exactly one entry; never any input text.
 *   FR6 cancellation:  registry.cancelRun forwards 'user' reason to handle.kill.
 *   AC6 runId:         every handler receives the runId minted at execute().
 *
 * The FileAgentAuditLog rotate/chmod path is already covered in
 * `src-main/features/security/audit-log.test.ts` (FR5), so this file uses a
 * lightweight recording fake instead.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RunInstructionUseCase, type RunInstructionHandlers } from './run-instruction.use-case';
import { REMOTE_PROTOCOL, REMOTE_QUESTION_UNAVAILABLE_ANSWER, REMOTE_SEND_FILE_LINE } from '../infrastructure/remote-protocol';
import { buildUiFallbackHint } from '../infrastructure/ui-tools-protocol';

/** What a run with NO interface tools is told instead. */
const UI_FALLBACK = buildUiFallbackHint([]) as string;
import { InMemoryProjectRegistry } from '../infrastructure/in-memory-project-registry';
import { createOutboxFlusher } from '../../outbox';
import {
  answerFilePath,
  readUiAnswer,
  uiRunDir,
  writeUiRequest,
} from '../../../shared/ui-rendezvous';
import type { UiToolName } from '../../../../shared/domain/ui-tools';
import { UiMcpInjector, type UiServerHarness } from '../../ui-tools';
import type {
  AgentRunner,
  AgentRunRequest,
} from '../infrastructure/cli-runner-adapter';
import type { AgentProcessHandle, AgentRunHandlers } from '../domain/ports';
import { StaticMapperRegistry } from '../../agents/infrastructure/static-mapper-registry';
import type { NativeConfigDelivery } from '../../agents/shared/native-config-mcp';
import type { CliAdapterRegistry } from '../../cli-adapters';
import type { WorktreeRef } from '../../git/domain/worktree-ref';
import type { EnsureWorktreeResult } from '../../git';
import type { RuntimeAgentDef, AgentExtraArgsOptions } from '../../cli-adapters/domain/runtime-agent-def';
import type {
  ConfigRepository,
  SessionStore,
  StateStore,
  AttachmentEnricher,
  OutboxFlusher,
} from '../../../shared/ports';
import type { TechDetector } from '../../workspace/domain/ports';
import type { DeviaConfig } from '../../../../shared/domain/config';
import type { AgentAuditLog, AuditEntry } from '../../security/audit-log';
import type { RunId } from '../../../../shared/domain/agent';
import type { ChatMessage } from '../../../../shared/domain/chat';
import type { PersistedSession } from '../../../../shared/domain/session';
import type { SavedAttachment } from '../../../../shared/domain/attachment';

// ── Fakes ──────────────────────────────────────────────────────────────────

class FakeConfig implements ConfigRepository {
  private cfg: DeviaConfig = {
    workspaceRoot: process.platform === 'win32' ? 'C:\\ws' : '/ws',
    ignoreFolders: [],
    agentId: 'fake-agent',
    agentModels: {},
    agentCliEnv: {},
    agentToolPolicy: {},
    memory: { enabled: true, blockExternalMemory: true, engramImported: false },
    remoteControl: { allowShell: false, mirrorDesktop: false, allowFileSend: true, telegram: { enabled: false, botToken: '', chatId: '' } },
    worktreePerSession: false,
  };
  constructor(private readonly deviaDirPath = '/tmp/.devia-app') {}
  get(): DeviaConfig { return this.cfg; }
  set(partial: Partial<DeviaConfig>): DeviaConfig { this.cfg = { ...this.cfg, ...partial }; return this.cfg; }
  reload(): DeviaConfig { return this.cfg; }
  hasWorkspace(): boolean { return this.cfg.workspaceRoot.length > 0; }
  configPath(): string { return '/tmp/devia.json'; }
  deviaDir(): string { return this.deviaDirPath; }
}

class FakeState implements StateStore {
  saves = 0;
  load(): void { /* no-op */ }
  save(): void { this.saves++; }
}

class FakeSessions implements SessionStore {
  newSessionId(): string { return 'sess-' + Math.random().toString(36).slice(2, 8); }
  isValidSessionId(id: string | null | undefined): id is string {
    return typeof id === 'string' && id.length > 0;
  }
  save(): void { /* no-op */ }
  load(): null { return null; }
  list(): [] { return []; }
  deleteOne(): void { /* no-op */ }
  deleteProjectSessions(): void { /* no-op */ }
  collectAllStats(): [] { return []; }
}

/** SessionStore stub that returns a fixed transcript on load (S-19 F0.3). */
class SessionsWithHistory implements SessionStore {
  loadCalls = 0;
  constructor(private readonly messages: ChatMessage[]) {}
  newSessionId(): string { return 'sess-hist'; }
  isValidSessionId(id: string | null | undefined): id is string {
    return typeof id === 'string' && id.length > 0;
  }
  save(): void { /* no-op */ }
  load(): PersistedSession {
    this.loadCalls++;
    return { messages: this.messages } as unknown as PersistedSession;
  }
  list(): [] { return []; }
  deleteOne(): void { /* no-op */ }
  deleteProjectSessions(): void { /* no-op */ }
  collectAllStats(): [] { return []; }
}

class FakeAttachments implements AttachmentEnricher {
  save(): SavedAttachment { throw new Error('not used'); }
  saveAll(): SavedAttachment[] { throw new Error('not used'); }
  augmentInstruction(instruction: string, saved: readonly SavedAttachment[]): string {
    void saved;
    return instruction;
  }
}

class FakeOutbox implements OutboxFlusher {
  flush(): [] { return []; }
}

class FakeTech implements TechDetector {
  detect(): 'git' { return 'git'; }
}

class RecordingAuditLog implements AgentAuditLog {
  entries: AuditEntry[] = [];
  append(entry: AuditEntry): void { this.entries.push(entry); }
  readLast(n: number): AuditEntry[] { return this.entries.slice(-n); }
}

/**
 * Captures the launch request and exposes the captured handlers so tests can
 * drive the lifecycle event-by-event.
 */
interface CapturedLaunch {
  req: AgentRunRequest;
  handlers: AgentRunHandlers;
  handle: AgentProcessHandle;
  killSpy: ReturnType<typeof vi.fn>;
  /** The agent's native answer channel (Claude stdin, pi, ACP). */
  answerSpy: ReturnType<typeof vi.fn>;
}

class FakeRunner implements AgentRunner {
  captured: CapturedLaunch[] = [];
  run(req: AgentRunRequest, handlers: AgentRunHandlers): AgentProcessHandle {
    const killSpy = vi.fn();
    const answerSpy = vi.fn(() => true);
    const handle: AgentProcessHandle = { kill: killSpy, answer: answerSpy };
    this.captured.push({ req, handlers, handle, killSpy, answerSpy });
    return handle;
  }
  /** Convenience accessor for the most recent capture. */
  last(): CapturedLaunch {
    const last = this.captured[this.captured.length - 1];
    if (!last) throw new Error('FakeRunner.last(): nothing captured yet');
    return last;
  }
}

/** The agent's stream, as its mapper's session would emit it. */
function emitEvent(capture: CapturedLaunch, event: Record<string, unknown>): void {
  capture.handlers.onOutput(JSON.stringify(event));
}
function emitToolUse(capture: CapturedLaunch, id: string, name: string, input: unknown): void {
  emitEvent(capture, { type: 'tool_use', id, name, input });
}

/** What reached the CLI's stdin (text agents). */
function stdinOf(capture: CapturedLaunch): string {
  const stdin = capture.req.prepared.stdin;
  return stdin.kind === 'text' || stdin.kind === 'stream' ? stdin.payload : '';
}
/** The `[System]` block of a stdin-prepend agent's payload. */
function stdinSystemPromptOf(capture: CapturedLaunch): string {
  return /^\[System\]\n([\s\S]*?)\n\n\[User\]\n/.exec(stdinOf(capture))?.[1] ?? '';
}
/** The user turn a stdin agent received (system header stripped). */
function stdinPromptOf(capture: CapturedLaunch): string {
  return stdinOf(capture).replace(/^\[System\]\n[\s\S]*?\n\n\[User\]\n/, '');
}

/** A native-config delivery double: every server lands, or none does. */
function nativeDelivery(delivers: boolean) {
  return {
    deliver: vi.fn((_agentId: string, _cwd: string, servers: readonly McpServerConfig[]): NativeConfigDelivery =>
      delivers ? { file: '/some/file', deliveredServerIds: servers.map((s) => s.id) } : { file: null, deliveredServerIds: [] }),
  };
}
/** The bundled `devia-ui` server with the advertised tools on its argv, like production. */
function uiServer(dir: string, tools: readonly UiToolName[]): McpServerConfig {
  return { id: 'devia-ui', name: 'devia-ui', command: 'node', args: ['server.js', '--ui-dir', dir, '--tools', tools.join(',')], enabled: true };
}
/** Extras for a native-config agent whose MCP write succeeds / fails. */
const nativeUi = (delivers: boolean): Pick<BuildExtras, 'nativeMcp' | 'uiMcpServer'> => ({
  nativeMcp: nativeDelivery(delivers),
  uiMcpServer: uiServer,
});

function makeDef(overrides: Partial<RuntimeAgentDef> = {}): RuntimeAgentDef {
  const extraArgsSpy = vi.fn(() => ['--extra']);
  return {
    id: 'fake-agent',
    name: 'Fake Agent',
    bin: 'fake',
    versionArgs: ['--version'],
    fallbackModels: [],
    streamFormat: 'plain',
    buildArgs: () => [],
    promptViaStdin: true,
    systemPromptStrategy: 'argv',
    defaultDisallowedTools: ['WebSearch'],
    buildExtraArgs: extraArgsSpy,
    ...overrides,
  };
}

class FakeRegistry implements CliAdapterRegistry {
  constructor(private readonly def: RuntimeAgentDef) {}
  all(): readonly RuntimeAgentDef[] { return [this.def]; }
  get(id: string): RuntimeAgentDef | null { return id === this.def.id ? this.def : null; }
  registerAdditional(): void { /* no-op */ }
  installMetaForAgent(): { installUrl?: string; docsUrl?: string } { return {}; }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeHandlers(overrides: Partial<RunInstructionHandlers> = {}): RunInstructionHandlers {
  return {
    onProcessStart: vi.fn(),
    onClaudeOutput: vi.fn(),
    onProcessEnd: vi.fn(),
    onOutboxFile: vi.fn(),
    ...overrides,
  };
}

function answerFileFor(runId: RunId, toolUseId: string): string {
  return path.join(uiRunDir(runId), `${toolUseId}.answer.json`);
}

function readAnswerFile(runId: RunId, toolUseId: string): unknown {
  return JSON.parse(fs.readFileSync(answerFileFor(runId, toolUseId), 'utf8')) as unknown;
}

interface Harness {
  uc: RunInstructionUseCase;
  runner: FakeRunner;
  registry: InMemoryProjectRegistry;
  audit: RecordingAuditLog;
  def: RuntimeAgentDef;
}

interface BuildExtras {
  config?: ConfigRepository;
  kanbanMcpServer?: (projectAbs: string) => McpServerConfig;
  memoryMcpServer?: (projectAbs: string, agentId?: string) => McpServerConfig;
  saveMemoryPrompt?: (projectAbs: string, content: string, sessionId?: string, agentId?: string) => void;
  saveMemoryHandoff?: (projectAbs: string, content: string, sessionId?: string, agentId?: string) => void;
  handoffSummary?: (identity: string, sessionId: string) => string | null;
  recentHandoffSummary?: (projectAbs: string, sessionId: string, agentId: string, maxAgeMs: number) => string | null;
  onSessionHandoff?: (event: { project: string; fromAgentId: string; toAgentId: string; summary: string; runId: RunId }) => void;
  sessions?: SessionStore;
  mcpServers?: McpServerRegistry;
  memoryContext?: (projectAbs: string, query: string) => import('../../../../shared/domain/memory').MemoryRecall;
  enterpriseMcpConfigPresent?: () => boolean;
  ensureSessionWorktree?: (ref: WorktreeRef) => EnsureWorktreeResult;
  uiMcpServer?: (uiDir: string, tools: readonly UiToolName[], harness?: UiServerHarness) => McpServerConfig;
  /** How a native-config agent's MCP write behaves (default: nothing lands). */
  nativeMcp?: { deliver: (agentId: string, cwd: string, servers: readonly McpServerConfig[]) => NativeConfigDelivery };
  implementedUiTools?: readonly UiToolName[];
  isConfirmationGranted?: (project: string, action: string) => boolean;
  remoteRelayConnected?: () => boolean;
  isLiveSessionWorktree?: (workdir: string) => boolean;
  outbox?: OutboxFlusher;
}

/** The production mapper registry, with test doubles for its side effects. */
function makeMappers(extras: Pick<BuildExtras, 'nativeMcp' | 'enterpriseMcpConfigPresent'> = {}): StaticMapperRegistry {
  return new StaticMapperRegistry({
    nativeMcp: extras.nativeMcp ?? nativeDelivery(false),
    ensureCodexTrust: () => undefined,
    ...(extras.enterpriseMcpConfigPresent && { enterpriseMcpConfigPresent: extras.enterpriseMcpConfigPresent }),
  });
}

function build(defOverrides: Partial<RuntimeAgentDef> = {}, extras: BuildExtras = {}): Harness {
  const def = makeDef(defOverrides);
  const runner = new FakeRunner();
  const registry = new InMemoryProjectRegistry();
  const audit = new RecordingAuditLog();
  const uc = new RunInstructionUseCase({
    config: extras.config ?? new FakeConfig(),
    sessions: extras.sessions ?? new FakeSessions(),
    state: new FakeState(),
    registry,
    runner,
    agents: new FakeRegistry(def),
    mappers: makeMappers(extras),
    attachments: new FakeAttachments(),
    outbox: extras.outbox ?? new FakeOutbox(),
    tech: new FakeTech(),
    auditLog: audit,
    ...(extras.kanbanMcpServer ? { kanbanMcpServer: extras.kanbanMcpServer } : {}),
    ...(extras.memoryMcpServer ? { memoryMcpServer: extras.memoryMcpServer } : {}),
    ...(extras.saveMemoryPrompt ? { saveMemoryPrompt: extras.saveMemoryPrompt } : {}),
    ...(extras.saveMemoryHandoff ? { saveMemoryHandoff: extras.saveMemoryHandoff } : {}),
    ...(extras.handoffSummary ? { handoffSummary: extras.handoffSummary } : {}),
    ...(extras.recentHandoffSummary ? { recentHandoffSummary: extras.recentHandoffSummary } : {}),
    ...(extras.onSessionHandoff ? { onSessionHandoff: extras.onSessionHandoff } : {}),
    ...(extras.mcpServers ? { mcpServers: extras.mcpServers } : {}),
    ...(extras.memoryContext ? { memoryContext: extras.memoryContext } : {}),
    ...(extras.ensureSessionWorktree ? { ensureSessionWorktree: extras.ensureSessionWorktree } : {}),
    ...(extras.uiMcpServer ? { uiMcpServer: extras.uiMcpServer } : {}),
    ...(extras.implementedUiTools ? { implementedUiTools: extras.implementedUiTools } : {}),
    ...(extras.isConfirmationGranted ? { isConfirmationGranted: extras.isConfirmationGranted } : {}),
    ...(extras.remoteRelayConnected ? { remoteRelayConnected: extras.remoteRelayConnected } : {}),
    ...(extras.isLiveSessionWorktree ? { isLiveSessionWorktree: extras.isLiveSessionWorktree } : {}),
  });
  return { uc, runner, registry, audit, def };
}

// ── FR1 — happy path ──────────────────────────────────────────────────────

describe('RunInstructionUseCase — happy path (FR1, AC6)', () => {
  it('emits onProcessStart then onClaudeOutput then onProcessEnd, all carrying the same runId', () => {
    const h = build();
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'Please refactor X', [], handlers);

    const startMock = handlers.onProcessStart as ReturnType<typeof vi.fn>;
    expect(startMock).toHaveBeenCalledOnce();
    const startArg = startMock.mock.calls[0]?.[0] as { runId: RunId };
    const runId = startArg.runId;
    expect(typeof runId).toBe('string');
    expect(runId.length).toBeGreaterThan(0);

    const capture = h.runner.last();
    capture.handlers.onOutput(JSON.stringify({ type: 'text_delta', delta: 'Hello' }));
    emitToolUse(capture, 'tool-1', 'Edit', { path: 'a.ts' });
    capture.handlers.onOutput(JSON.stringify({ type: 'tool_result', toolUseId: 'tool-1' }));
    capture.handlers.onDone(0);

    const outputMock = handlers.onClaudeOutput as ReturnType<typeof vi.fn>;
    expect(outputMock).toHaveBeenCalled();
    for (const call of outputMock.mock.calls) {
      expect(call[1]).toBe(runId);
    }

    const endMock = handlers.onProcessEnd as ReturnType<typeof vi.fn>;
    expect(endMock).toHaveBeenCalledOnce();
    const endArg = endMock.mock.calls[0]?.[0] as { runId: RunId; code: number | null };
    expect(endArg.runId).toBe(runId);
    expect(endArg.code).toBe(0);
  });

  it('attaches the process handle to the registry with the minted runId', () => {
    const h = build();
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'do thing', [], handlers);

    expect(h.registry.isRunning('proj-a')).toBe(true);
    // Cancel via the runId path proves currentRunId was stored.
    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };
    h.registry.cancelRun(startArg.runId);
    expect(h.runner.last().killSpy).toHaveBeenCalledWith('user');
  });

  it('forwards the resolved RunCapabilities + systemPrompt into buildExtraArgs', () => {
    const h = build();
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'plan');

    const buildExtraArgs = h.def.buildExtraArgs as ReturnType<typeof vi.fn>;
    expect(buildExtraArgs).toHaveBeenCalledOnce();
    const opts = buildExtraArgs.mock.calls[0]?.[0] as AgentExtraArgsOptions;
    expect(opts.capabilities?.mode).toBe('plan');
    // plan mode injects file-mutating tools into the denylist on top of the adapter default.
    expect(opts.capabilities?.disallowedTools).toEqual(
      expect.arrayContaining(['WebSearch', 'Edit', 'Write', 'MultiEdit', 'Bash']),
    );
    expect(typeof opts.systemPrompt).toBe('string');
    expect(opts.systemPrompt.length).toBeGreaterThan(0);
  });

  it('keeps the Workflow tool in plan mode but drops it in apply/apply-yolo (Claude, S-16 T-189)', () => {
    const planH = build({ id: 'claude', name: 'Claude Code' });
    planH.uc.execute('proj-a', 'analyse this', [], makeHandlers(), 'plan');
    const planOpts = (planH.def.buildExtraArgs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as AgentExtraArgsOptions;
    expect(planOpts.capabilities?.disallowedTools).not.toContain('Workflow');

    for (const mode of ['apply', 'apply-yolo'] as const) {
      const h = build({ id: 'claude', name: 'Claude Code' });
      h.uc.execute('proj-a', 'do it', [], makeHandlers(), mode);
      const opts = (h.def.buildExtraArgs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as AgentExtraArgsOptions;
      expect(opts.capabilities?.disallowedTools).toContain('Workflow');
    }
  });

  it('never gates Workflow for non-Claude agents', () => {
    const h = build(); // fake-agent
    h.uc.execute('proj-a', 'do it', [], makeHandlers(), 'apply');
    const opts = (h.def.buildExtraArgs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as AgentExtraArgsOptions;
    expect(opts.capabilities?.disallowedTools).not.toContain('Workflow');
  });

  // The def turns the plan's extra dirs into its own flag (Claude/Codex `--add-dir`).
  const addDirDef: Partial<RuntimeAgentDef> = {
    buildArgs: (_p, _i, dirs = []) => dirs.flatMap((d) => ['--add-dir', d]),
  };

  it('grants whole-workspace visibility via extraAllowedDirs in confined modes', () => {
    const ws = process.platform === 'win32' ? 'C:\\ws' : '/ws';
    for (const mode of ['plan', 'apply'] as const) {
      const h = build(addDirDef);
      h.uc.execute('proj-a', 'do it', [], makeHandlers(), mode);
      expect(h.runner.last().req.prepared.args.slice(0, 2)).toEqual(['--add-dir', ws]);
    }
  });

  it('omits extraAllowedDirs in apply-yolo (no confinement to widen)', () => {
    const h = build(addDirDef);
    h.uc.execute('proj-a', 'do it', [], makeHandlers(), 'apply-yolo');
    expect(h.runner.last().req.prepared.args).not.toContain('--add-dir');
  });

  it('does not write prompt contents to process logs', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const h = build();
      h.uc.execute('proj-a', 'API_KEY=secret-value-123456', [], makeHandlers());

      const lines = log.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(lines).toContain('promptChars=');
      expect(lines).not.toContain('API_KEY');
      expect(lines).not.toContain('secret-value');
    } finally {
      log.mockRestore();
    }
  });
});

// ── FR2 + FR3 — AskUserQuestion timer ──────────────────────────────────────

describe('RunInstructionUseCase — AskUserQuestion timer (FR2, FR3, AC2)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does NOT kill when the turn ends before 5 minutes (timer cleared on turn_end)', () => {
    const h = build();
    const handlers = makeHandlers({ onQuestionAsk: vi.fn() });
    h.uc.execute('proj-a', 'ask user', [], handlers);

    const capture = h.runner.last();
    emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });

    // User "answers" — turn_end fires which clears the timer.
    emitEvent(capture, { type: 'turn_end', stopReason: 'end_turn' });
    vi.advanceTimersByTime(10 * 60 * 1_000);

    expect(capture.killSpy).not.toHaveBeenCalled();
    expect(handlers.onQuestionAsk).toHaveBeenCalledOnce();
  });

  it('does not ask twice when the same AskUserQuestion tool_use id is repeated', () => {
    const h = build();
    const handlers = makeHandlers({ onQuestionAsk: vi.fn() });
    h.uc.execute('proj-a', 'ask user', [], handlers);

    const capture = h.runner.last();
    emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });
    emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });

    expect(handlers.onQuestionAsk).toHaveBeenCalledOnce();
  });

  it('clears the AskUserQuestion timeout when the renderer writes a tool result', () => {
    const h = build();
    const handlers = makeHandlers({ onQuestionAsk: vi.fn() });
    h.uc.execute('proj-a', 'ask user', [], handlers);
    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };

    const capture = h.runner.last();
    emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });
    h.registry.writeToolResult('proj-a', 'tu-1', 'answer');

    expect(capture.answerSpy).not.toHaveBeenCalled();
    expect(readAnswerFile(startArg.runId, 'tu-1')).toEqual({ answer: 'answer' });
    vi.advanceTimersByTime(10 * 60 * 1_000);
    expect(capture.killSpy).not.toHaveBeenCalled();
  });

  it('keeps the timeout alive on stopReason=tool_use while waiting for the answer', () => {
    const h = build();
    h.uc.execute('proj-a', 'ask user', [], makeHandlers({ onQuestionAsk: vi.fn() }));

    const capture = h.runner.last();
    emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });
    emitEvent(capture, { type: 'turn_end', stopReason: 'tool_use' });

    vi.advanceTimersByTime(5 * 60 * 1_000);
    expect(capture.killSpy).toHaveBeenCalledWith('question_timeout');
  });

  it('kills the handle with cancelReason=question_timeout after 5 minutes with no answer', () => {
    const h = build();
    const handlers = makeHandlers({ onQuestionAsk: vi.fn() });
    h.uc.execute('proj-a', 'ask user', [], handlers);

    const capture = h.runner.last();
    emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });

    vi.advanceTimersByTime(5 * 60 * 1_000);

    expect(capture.killSpy).toHaveBeenCalledOnce();
    expect(capture.killSpy).toHaveBeenCalledWith('question_timeout');
  });

  it('clears the timer on onDone so it cannot fire after a clean exit', () => {
    const h = build();
    h.uc.execute('proj-a', 'ask user', [], makeHandlers({ onQuestionAsk: vi.fn() }));

    const capture = h.runner.last();
    emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });
    capture.handlers.onDone(0);

    vi.advanceTimersByTime(10 * 60 * 1_000);
    expect(capture.killSpy).not.toHaveBeenCalled();
  });

  it('clears the timer on onError so it cannot fire after a crash', () => {
    const h = build();
    h.uc.execute('proj-a', 'ask user', [], makeHandlers({ onQuestionAsk: vi.fn() }));

    const capture = h.runner.last();
    emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });
    capture.handlers.onError('boom');

    vi.advanceTimersByTime(10 * 60 * 1_000);
    expect(capture.killSpy).not.toHaveBeenCalled();
  });
});

// ── Remote (Telegram) origin — interactive questions safety net ─────────────

describe('RunInstructionUseCase — remote origin (Telegram)', () => {
  it('appends the remote protocol to the system prompt only for remote runs', () => {
    const renderer = build();
    renderer.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'renderer');
    const rendererPrompt = (renderer.def.buildExtraArgs as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0]?.systemPrompt as string;
    expect(rendererPrompt).not.toContain(REMOTE_PROTOCOL);

    const remote = build();
    remote.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'remote');
    const remotePrompt = (remote.def.buildExtraArgs as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0]?.systemPrompt as string;
    expect(remotePrompt).toContain(REMOTE_PROTOCOL);
  });

  describe('AskUserQuestion auto-answer', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('auto-answers AskUserQuestion instead of surfacing a card or arming the kill timer', () => {
      const h = build();
      const handlers = makeHandlers({ onQuestionAsk: vi.fn() });
      h.uc.execute('proj-a', 'ask user', [], handlers, 'apply', [], 'remote');

      const capture = h.runner.last();
      emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });

      // No card surfaced to the (absent) desktop user…
      expect(handlers.onQuestionAsk).not.toHaveBeenCalled();
      // …a canned tool result is delivered to the agent instead…
      expect(capture.answerSpy).toHaveBeenCalledWith('tu-1', { kind: 'text', text: REMOTE_QUESTION_UNAVAILABLE_ANSWER });
      // …and the 5-minute kill timer never fires.
      vi.advanceTimersByTime(10 * 60 * 1_000);
      expect(capture.killSpy).not.toHaveBeenCalled();
    });

    it('auto-answers through the agent channel for Claude too, never the rendezvous file', () => {
      // S-24: a remote run is not given devia-ask, so no server would ever read
      // an answer file — the canned result has to travel the agent's own channel.
      const h = build({ id: 'claude', name: 'Claude Code' });
      const handlers = makeHandlers({ onQuestionAsk: vi.fn() });
      h.uc.execute('proj-a', 'ask user', [], handlers, 'apply', [], 'remote');
      const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };

      const capture = h.runner.last();
      emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });

      expect(handlers.onQuestionAsk).not.toHaveBeenCalled();
      expect(capture.answerSpy).toHaveBeenCalledWith('tu-1', { kind: 'text', text: REMOTE_QUESTION_UNAVAILABLE_ANSWER });
      expect(fs.existsSync(answerFileFor(startArg.runId, 'tu-1'))).toBe(false);
    });

    it('still surfaces the question card for renderer-origin runs (no auto-answer)', () => {
      const h = build();
      const handlers = makeHandlers({ onQuestionAsk: vi.fn() });
      h.uc.execute('proj-a', 'ask user', [], handlers, 'apply', [], 'renderer');

      const capture = h.runner.last();
      emitToolUse(capture, 'tu-1', 'AskUserQuestion', { question: 'What?' });

      expect(handlers.onQuestionAsk).toHaveBeenCalledOnce();
      expect(capture.answerSpy).not.toHaveBeenCalled();
    });
  });
});

// ── FR4 — audit log ────────────────────────────────────────────────────────

describe('RunInstructionUseCase — audit log (FR4, AC3)', () => {
  it('appends one entry per tool_use with the runId + mode and no input payload', () => {
    const h = build();
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'secret prompt text', [], handlers, 'apply-yolo');

    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };
    const capture = h.runner.last();
    emitToolUse(capture, 't-1', 'Edit', { path: 'a.ts', content: 'secret edit body' });
    emitToolUse(capture, 't-2', 'Bash', { command: 'rm -rf /' });

    const last = h.audit.readLast(10);
    expect(last).toHaveLength(2);
    expect(last[0]?.tool).toBe('Edit');
    expect(last[0]?.runId).toBe(startArg.runId);
    expect(last[0]?.mode).toBe('apply-yolo');
    expect(last[0]?.agentId).toBe('fake-agent');
    expect(last[0]?.project).toBe('proj-a');
    expect(last[1]?.tool).toBe('Bash');

    // No leakage of prompt text or tool input.
    for (const entry of last) {
      const serialised = JSON.stringify(entry);
      expect(serialised).not.toContain('secret prompt');
      expect(serialised).not.toContain('secret edit body');
      expect(serialised).not.toContain('rm -rf');
    }
  });

  it('does not throw when no audit log is configured (optional dep)', () => {
    const def = makeDef();
    const runner = new FakeRunner();
    const uc = new RunInstructionUseCase({
      config: new FakeConfig(),
      sessions: new FakeSessions(),
      state: new FakeState(),
      registry: new InMemoryProjectRegistry(),
      runner,
      agents: new FakeRegistry(def),
      mappers: makeMappers(),
      attachments: new FakeAttachments(),
      outbox: new FakeOutbox(),
      tech: new FakeTech(),
      // no auditLog
    });
    uc.execute('proj-a', 'hi', [], makeHandlers());
    expect(() =>
      emitToolUse(runner.last(), 't-1', 'Edit', {}),
    ).not.toThrow();
  });
});

// ── FR6 — cancellation propagation ─────────────────────────────────────────

describe('RunInstructionUseCase — cancellation (FR6)', () => {
  it('forwards cancelReason from registry.cancelRun → handle.kill → onProcessEnd', () => {
    const h = build();
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };
    h.registry.cancelRun(startArg.runId);

    const capture = h.runner.last();
    expect(capture.killSpy).toHaveBeenCalledWith('user');

    // Simulate the launcher routing the kill back through onError with the reason.
    capture.handlers.onError('cancelled by user', undefined, 'SIGTERM', 'user');

    const endMock = handlers.onProcessEnd as ReturnType<typeof vi.fn>;
    expect(endMock).toHaveBeenCalledOnce();
    const endArg = endMock.mock.calls[0]?.[0] as { runId: RunId; cancelReason?: string };
    expect(endArg.runId).toBe(startArg.runId);
    expect(endArg.cancelReason).toBe('user');
  });

  it('stopProject sends cancelReason=user to the launcher kill', () => {
    const h = build();
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    h.registry.stopProject('proj-a');
    expect(h.runner.last().killSpy).toHaveBeenCalledWith('user');
  });

  it('cancelRun is idempotent — second call is a true no-op', () => {
    const h = build();
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'do thing', [], handlers);
    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };

    h.registry.cancelRun(startArg.runId);
    h.registry.cancelRun(startArg.runId);
    expect(h.runner.last().killSpy).toHaveBeenCalledTimes(1);
  });

  it('reports busy with the new runId when a second execute fires while one is running', () => {
    const h = build();
    h.uc.execute('proj-a', 'first', [], makeHandlers());

    const second = makeHandlers();
    h.uc.execute('proj-a', 'second', [], second);

    const endMock = second.onProcessEnd as ReturnType<typeof vi.fn>;
    expect(endMock).toHaveBeenCalledOnce();
    const endArg = endMock.mock.calls[0]?.[0] as { error?: string };
    expect(endArg.error).toBe('busy');
    // Only one process actually spawned.
    expect(h.runner.captured).toHaveLength(1);
  });

  // ── S-13 T-143 Stage A — per-session run identity (runKey) ────────────────

  it('a second run of the SAME project with a distinct runKey is NOT busy (isolated identity)', () => {
    const h = build();
    h.uc.execute('proj-a', 'first', [], makeHandlers());
    expect(h.registry.isRunning('proj-a')).toBe(true);

    const second = makeHandlers();
    // runKey distinguishes the additional pane's session from the primary one.
    h.uc.execute('proj-a', 'second', [], second, 'apply', [], 'renderer', false, 'proj-a::s2');

    const endMock = second.onProcessEnd as ReturnType<typeof vi.fn>;
    const endArg = endMock.mock.calls[0]?.[0] as { error?: string } | undefined;
    expect(endArg?.error).not.toBe('busy');
    // Two processes spawned, under two distinct registry identities.
    expect(h.runner.captured).toHaveLength(2);
    expect(h.registry.isRunning('proj-a::s2')).toBe(true);
  });

  it('with no runKey the registry identity is the projectName (zero regression)', () => {
    const h = build();
    h.uc.execute('proj-a', 'only', [], makeHandlers());
    expect(h.registry.isRunning('proj-a')).toBe(true);
    // No synthetic identity leaked.
    expect(h.registry.isRunning('proj-a::s2')).toBe(false);
  });
});

// ── UC-FIX-005 — MCP scope warning ───────────────────────────────────────────

import { McpServerRegistry } from '../../mcp';

function buildWithMcp(
  agentId: string,
  mcpServers: McpServerRegistry | undefined,
  defOverrides: Partial<RuntimeAgentDef> = {},
): Harness {
  const def = makeDef({ id: agentId, name: agentId, ...defOverrides });
  const runner = new FakeRunner();
  const registry = new InMemoryProjectRegistry();
  const audit = new RecordingAuditLog();
  const extraDeps = mcpServers !== undefined ? { mcpServers } : {};
  const uc = new RunInstructionUseCase({
    config: new FakeConfig(),
    sessions: new FakeSessions(),
    state: new FakeState(),
    registry,
    runner,
    agents: new FakeRegistry(def),
    mappers: makeMappers(),
    attachments: new FakeAttachments(),
    outbox: new FakeOutbox(),
    tech: new FakeTech(),
    auditLog: audit,
    ...extraDeps,
  });
  return { uc, runner, registry, audit, def };
}

import type { McpServerConfig } from '../../../../shared/domain/mcp';

function makeMcpRegistry(servers: McpServerConfig[]): McpServerRegistry {
  return new McpServerRegistry(servers);
}

function enabledServer(id: string): McpServerConfig {
  return { id, name: id, command: 'npx', args: [id], enabled: true };
}

describe('RunInstructionUseCase — MCP scope warning (UC-FIX-005)', () => {
  it('AC1: agent without MCP support and enabled MCP servers emits a status warning', () => {
    const mcp = makeMcpRegistry([enabledServer('my-server')]);
    const h = buildWithMcp('deepseek', mcp);
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const outputMock = handlers.onClaudeOutput as ReturnType<typeof vi.fn>;
    const statusEvents = outputMock.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((call: any[]) => { const line = call[0] as string; try { return JSON.parse(line) as { type: string; label?: string }; } catch { return null; } })
      .filter((e) => e?.type === 'status');

    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    const warn = statusEvents.find((e) => e?.label?.includes('MCP') && e.label.includes('ignored'));
    expect(warn).toBeDefined();
  });

  it('AC2: claude agent with MCP servers does NOT emit a warning', () => {
    const mcp = makeMcpRegistry([enabledServer('my-server')]);
    const h = buildWithMcp('claude', mcp, { id: 'claude' });
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const outputMock = handlers.onClaudeOutput as ReturnType<typeof vi.fn>;
    const warnEvents = outputMock.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((call: any[]) => { const line = call[0] as string; try { return JSON.parse(line) as { type: string; label?: string }; } catch { return null; } })
      .filter((e) => e?.type === 'status' && e.label?.includes('MCP') && e.label?.includes('ignored'));

    expect(warnEvents).toHaveLength(0);
  });

  it('AC3: no MCP servers configured — no warning regardless of agent', () => {
    const mcp = makeMcpRegistry([]); // empty
    const h = buildWithMcp('codex', mcp);
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const outputMock = handlers.onClaudeOutput as ReturnType<typeof vi.fn>;
    const warnEvents = outputMock.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((call: any[]) => { const line = call[0] as string; try { return JSON.parse(line) as { type: string; label?: string }; } catch { return null; } })
      .filter((e) => e?.type === 'status' && e.label?.includes('MCP'));

    expect(warnEvents).toHaveLength(0);
  });
});

// ── AC6 — runId on every event surface ─────────────────────────────────────

describe('RunInstructionUseCase — runId envelope (AC6)', () => {
  it('threads the same runId through onQuestionAsk and onFileToolResult', () => {
    const h = build();
    const onQuestionAsk = vi.fn();
    const onFileToolResult = vi.fn();
    const handlers = makeHandlers({ onQuestionAsk, onFileToolResult });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };
    const capture = h.runner.last();
    emitToolUse(capture, 'q-1', 'AskUserQuestion', { question: 'Y?' });
    emitToolUse(capture, 'e-1', 'Edit', { path: 'a.ts' });
    capture.handlers.onOutput(JSON.stringify({ type: 'tool_result', toolUseId: 'e-1' }));

    expect(onQuestionAsk).toHaveBeenCalledWith('q-1', 'Y?', startArg.runId, undefined, [
      { id: 'q1', question: 'Y?' },
    ]);
    expect(onFileToolResult).toHaveBeenCalledWith('e-1', expect.any(String), startArg.runId);
  });

  it('forwards AskUserQuestion options from the nested Claude schema', () => {
    const h = build();
    const onQuestionAsk = vi.fn();
    const handlers = makeHandlers({ onQuestionAsk });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };
    const capture = h.runner.last();
    emitToolUse(capture, 'q-2', 'AskUserQuestion', {
      questions: [{ header: 'Choice', question: 'Pick one', options: [{ label: 'A', description: 'da' }, { label: 'B' }] }],
    });

    expect(onQuestionAsk).toHaveBeenCalledWith(
      'q-2',
      'Pick one',
      startArg.runId,
      [
        { label: 'A', description: 'da' },
        { label: 'B' },
      ],
      [
        {
          id: 'q1',
          header: 'Choice',
          question: 'Pick one',
          options: [
            { label: 'A', description: 'da' },
            { label: 'B' },
          ],
        },
      ],
    );
  });

  it('normalizes the Devia picker schema with header, multiSelect and descriptions', () => {
    const h = build();
    const onQuestionAsk = vi.fn();
    const handlers = makeHandlers({ onQuestionAsk });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };
    emitToolUse(h.runner.last(), 'q-3', 'AskUserQuestion', {
      questions: [{
        question: '¿Qué framework de testing prefieres?',
        header: 'Framework',
        multiSelect: false,
        options: [
          { label: 'Vitest', description: 'Rápido, nativo para Vite, compatible con Jest API.' },
          { label: 'Jest', description: 'El más popular, ecosistema amplio, gran soporte en CI/CD.' },
          { label: 'Mocha', description: 'Flexible y minimalista, requiere más configuración manual.' },
        ],
      }],
    });

    expect(onQuestionAsk).toHaveBeenCalledWith(
      'q-3',
      '¿Qué framework de testing prefieres?',
      startArg.runId,
      [
        { label: 'Vitest', description: 'Rápido, nativo para Vite, compatible con Jest API.' },
        { label: 'Jest', description: 'El más popular, ecosistema amplio, gran soporte en CI/CD.' },
        { label: 'Mocha', description: 'Flexible y minimalista, requiere más configuración manual.' },
      ],
      [
        {
          id: 'q1',
          header: 'Framework',
          question: '¿Qué framework de testing prefieres?',
          options: [
            { label: 'Vitest', description: 'Rápido, nativo para Vite, compatible con Jest API.' },
            { label: 'Jest', description: 'El más popular, ecosistema amplio, gran soporte en CI/CD.' },
            { label: 'Mocha', description: 'Flexible y minimalista, requiere más configuración manual.' },
          ],
        },
      ],
    );
  });

  it('writes the user answer to the rendezvous file the devia-ui server polls', () => {
    const h = build();
    const handlers = makeHandlers({ onQuestionAsk: vi.fn() });
    h.uc.execute('proj-a', 'do thing', [], handlers);
    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };

    const capture = h.runner.last();
    emitToolUse(capture, 'q-structured', 'AskUserQuestion', {
      questions: [{
        question: '¿Qué framework de testing prefieres?',
        header: 'Testing',
        multiSelect: false,
        options: [
          { label: 'Vitest', description: 'Moderno, integrado con Vite, rápido.' },
          { label: 'Jest', description: 'Estándar de la industria, muy maduro.' },
          { label: 'Mocha', description: 'Flexible y minimalista.' },
        ],
      }],
    });
    h.registry.writeToolResult('proj-a', 'q-structured', 'Vitest');

    expect(capture.answerSpy).not.toHaveBeenCalled();
    expect(readAnswerFile(startArg.runId, 'q-structured')).toEqual({ answer: 'Vitest' });
  });

  it('uses a string fallback when AskUserQuestion input is undefined', () => {
    const h = build();
    const onQuestionAsk = vi.fn();
    const handlers = makeHandlers({ onQuestionAsk });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };
    emitToolUse(h.runner.last(), 'q-4', 'AskUserQuestion', undefined);

    expect(onQuestionAsk).toHaveBeenCalledWith('q-4', 'undefined', startArg.runId, undefined, [
      { question: 'undefined' },
    ]);
  });
});

// ── S-24 — devia-ask delivery and the question rendezvous ───────────────────

describe('RunInstructionUseCase — devia-ui delivery (S-25)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-ask-wiring-'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function projectConfig(): FakeConfig {
    const cfg = new FakeConfig(path.join(tmpDir, '.devia-app'));
    cfg.set({ workspaceRoot: tmpDir });
    return cfg;
  }

  function uiDirFor(handlers: ReturnType<typeof makeHandlers>): string {
    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };
    return uiRunDir(startArg.runId);
  }

  it('creates the rendezvous directory before the spawn, so the server can write into it', () => {
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      uiMcpServer: () => enabledServer('devia-ui'),
    });
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'do thing', [], handlers);

    expect(fs.existsSync(uiDirFor(handlers))).toBe(true);
  });

  it('delivers devia-ui to Claude through --mcp-config and grants it', () => {
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      uiMcpServer: () => enabledServer('devia-ui'),
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    const file = path.join(tmpDir, 'proj-a', '.claude', 'settings.local.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions?: { allow?: string[] } };
    expect(parsed.permissions?.allow).toContain('mcp__devia-ui');
  });

  it('keys the server by the per-run directory, not by project', () => {
    const seen: string[] = [];
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      uiMcpServer: (uiDir) => { seen.push(uiDir); return enabledServer('devia-ui'); },
    });
    const first = makeHandlers();
    h.uc.execute('proj-a', 'one', [], first);
    h.registry.detachProcess('proj-a');
    const second = makeHandlers();
    h.uc.execute('proj-a', 'two', [], second);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toBe(uiDirFor(first));
  });

  it('delivers devia-ui to a non-Claude agent native config, with the run cwd', () => {
    const extras = nativeUi(true);
    const h = build({ id: 'codex', name: 'Codex' }, { config: projectConfig(), ...extras });
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'do thing', [], handlers);

    expect(extras.nativeMcp?.deliver).toHaveBeenCalledTimes(1);
    const [agentId, cwd, servers] = (extras.nativeMcp?.deliver as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, McpServerConfig[]];
    expect(agentId).toBe('codex');
    expect(cwd).toBe(path.join(tmpDir, 'proj-a'));
    expect(servers.find((s) => s.id === 'devia-ui')?.args).toContain(uiDirFor(handlers));
  });

  it('never writes a native config for Claude — devia-ui rides --mcp-config', () => {
    const nativeMcp = nativeDelivery(true);
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      uiMcpServer: () => enabledServer('devia-ui'),
      nativeMcp,
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    expect(nativeMcp.deliver).not.toHaveBeenCalled();
    expect(h.runner.last().req.prepared.args).toContain('--mcp-config');
  });

  it('withholds every interactive tool from a remote run — a Telegram user cannot click', () => {
    const seen: Array<readonly string[]> = [];
    const uiMcpServer = vi.fn((_dir: string, tools: readonly UiToolName[]) => {
      seen.push(tools);
      return enabledServer('devia-ui');
    });
    const claude = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(), uiMcpServer,
    });
    claude.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'remote');

    const codex = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(), uiMcpServer, nativeMcp: nativeDelivery(true),
    });
    codex.uc.execute('proj-b', 'do thing', [], makeHandlers(), 'apply', [], 'remote');

    // The non-interactive ones survive (a status list still helps a remote
    // user); anything that needs a click is gone, which also keeps its schema
    // out of the cached prefix on every remote turn.
    expect(seen).toHaveLength(2);
    for (const tools of seen) {
      expect(tools).not.toContain('ask_user');
      expect(tools).not.toContain('confirm');
      expect(tools).toContain('todo');
    }
  });

  it('does not deliver devia-ui under an enterprise MCP config', () => {
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      uiMcpServer: () => enabledServer('devia-ui'),
      enterpriseMcpConfigPresent: () => true,
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    expect(h.runner.last().req.prepared.args).not.toContain('--mcp-config');
    expect(h.runner.last().req.prepared.mcpServerIds).toEqual([]);
  });

  it('passes the advertised tool set to the server, not the whole surface', () => {
    const seen: Array<readonly string[]> = [];
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      uiMcpServer: (_dir, tools) => { seen.push(tools); return enabledServer('devia-ui'); },
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    // apply mode, narrowed to the tools this build can draw. `plan_approve` is
    // plan-only and the rest have no card yet.
    // apply mode. `plan_approve` is plan-only; `skill` needs a skills
    // directory, which the fixture project has none of.
    expect(seen[0]).toEqual(['ask_user', 'todo', 'request_review', 'confirm', 'pick', 'notify']);
  });

  it('delivers pi its servers through a per-run -e extension, never its native config', () => {
    const nativeMcp = nativeDelivery(true);
    // A stale entry from before the extension delivery: it would OVERRIDE the
    // registration (file wins in pi), so the run must strip it.
    const piFile = path.join(tmpDir, 'proj-a', '.pi', 'mcp.json');
    fs.mkdirSync(path.dirname(piFile), { recursive: true });
    fs.writeFileSync(piFile, JSON.stringify({ mcpServers: { 'devia-kanban': { command: 'x', __devia_managed: 'devia-kanban' } } }));
    const h = build({ id: 'pi', name: 'Pi' }, {
      config: projectConfig(),
      kanbanMcpServer: () => enabledServer('devia-kanban'),
      memoryMcpServer: () => enabledServer('devia-memory'),
      uiMcpServer: () => enabledServer('devia-ui'),
      nativeMcp,
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    const extraArgs = h.runner.last().req.prepared.args ?? [];
    const ext = extraArgs[extraArgs.indexOf('-e') + 1];
    expect(ext).toMatch(/pi-mcp-.*\.mjs$/);
    const source = fs.readFileSync(ext!, 'utf8');
    for (const id of ['devia-kanban', 'devia-memory', 'devia-ui']) expect(source).toContain(`"${id}"`);
    expect(nativeMcp.deliver).not.toHaveBeenCalled();
    expect(fs.existsSync(piFile)).toBe(false);
  });

  it('writes every bundled server to a native-config agent in ONE delivery per run', () => {
    const extras = nativeUi(true);
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      kanbanMcpServer: () => enabledServer('devia-kanban'),
      memoryMcpServer: () => enabledServer('devia-memory'),
      ...extras,
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    expect(extras.nativeMcp?.deliver).toHaveBeenCalledTimes(1);
    const servers = (extras.nativeMcp?.deliver as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as McpServerConfig[];
    expect(servers.map((s) => s.id)).toEqual(['devia-kanban', 'devia-memory', 'devia-ui']);
  });

  it('a failed native write leaves the run without devia-ui', () => {
    const h = build({ id: 'codex', name: 'Codex' }, { config: projectConfig(), ...nativeUi(false) });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    expect(h.runner.last().req.prepared.mcpServerIds).not.toContain('devia-ui');
  });

  it('dispatches a rendezvous request by its tool, ignoring one it cannot serve', async () => {
    const onQuestionAsk = vi.fn();
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(true),
    });
    const handlers = makeHandlers({ onQuestionAsk });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const dir = uiDirFor(handlers);
    // `todo` is advertised in intent but not wired yet: a blocking call would
    // hang the run, so an unhandled request must be answered, not ignored.
    writeUiRequest(dir, {
      callId: 'todo-1',
      tool: 'todo',
      toolInput: { items: [] },
      expectsAnswer: false,
    });
    writeUiRequest(dir, {
      callId: 'ask-9',
      tool: 'ask_user',
      toolInput: { questions: [{ question: '¿Sigo?', options: [{ label: 'Sí' }] }] },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(onQuestionAsk).toHaveBeenCalledOnce();
    expect(onQuestionAsk.mock.calls[0]?.[1]).toBe('¿Sigo?');
    // Fire-and-forget with no handler is swept, so the poller cannot re-emit it.
    expect(fs.existsSync(path.join(dir, 'todo-1.request.json'))).toBe(false);
  });

  it('answers an unhandled BLOCKING request instead of letting it hang', async () => {
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(true),
    });
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const dir = uiDirFor(handlers);
    writeUiRequest(dir, { callId: 'c-1', tool: 'confirm', toolInput: { action: 'rm -rf x' } });
    await vi.advanceTimersByTimeAsync(150);

    expect(readUiAnswer(answerFilePath(dir, 'c-1'))?.answer).toContain('not available');
  });

  it('forwards a non-question tool through the generic path, normalised', async () => {
    const onUiToolRequest = vi.fn();
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(true),
      implementedUiTools: ['ask_user', 'confirm', 'todo'],
    });
    const handlers = makeHandlers({ onUiToolRequest });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const dir = uiDirFor(handlers);
    writeUiRequest(dir, {
      callId: 'k-1',
      tool: 'confirm',
      toolInput: { action: 'rm -rf dist', danger: true },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(onUiToolRequest).toHaveBeenCalledOnce();
    const [callId, tool, input, , expectsAnswer] = onUiToolRequest.mock.calls[0] as [
      string, string, { action: string; danger?: boolean }, unknown, boolean,
    ];
    expect(callId).toBe('k-1');
    expect(tool).toBe('confirm');
    expect(input).toEqual({ action: 'rm -rf dist', danger: true });
    expect(expectsAnswer).toBe(true);
  });

  it('routes a generic tool answer to the rendezvous file', async () => {
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(true),
      implementedUiTools: ['ask_user', 'confirm'],
    });
    const handlers = makeHandlers({ onUiToolRequest: vi.fn() });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const dir = uiDirFor(handlers);
    writeUiRequest(dir, { callId: 'k-2', tool: 'confirm', toolInput: { action: 'x' } });
    await vi.advanceTimersByTimeAsync(150);
    h.registry.writeToolResult('proj-a', 'k-2', 'The user CONFIRMED.');

    expect(readUiAnswer(answerFilePath(dir, 'k-2'))).toEqual({ answer: 'The user CONFIRMED.' });
  });

  it('answers instead of drawing a card when the arguments are unusable', async () => {
    const onUiToolRequest = vi.fn();
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(true),
      implementedUiTools: ['ask_user', 'confirm'],
    });
    const handlers = makeHandlers({ onUiToolRequest });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const dir = uiDirFor(handlers);
    writeUiRequest(dir, { callId: 'k-3', tool: 'confirm', toolInput: { nope: 1 } });
    await vi.advanceTimersByTimeAsync(150);

    expect(onUiToolRequest).not.toHaveBeenCalled();
    expect(readUiAnswer(answerFilePath(dir, 'k-3'))?.answer).toContain('unusable');
  });

  it('never arms the kill timer for a fire-and-forget tool', async () => {
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(true),
      implementedUiTools: ['ask_user', 'todo'],
    });
    const handlers = makeHandlers({ onUiToolRequest: vi.fn() });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    writeUiRequest(uiDirFor(handlers), {
      callId: 'k-4',
      tool: 'todo',
      toolInput: { items: [{ text: 'uno' }] },
      expectsAnswer: false,
    });
    await vi.advanceTimersByTimeAsync(150);
    // Well past the 5-minute blocking timeout: a status card must never be able
    // to kill a run just because nobody "answered" it.
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(h.runner.last().killSpy).not.toHaveBeenCalled();
  });

  it('audits the request and its outcome, with the decision but never the payload', async () => {
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(true),
      implementedUiTools: ['ask_user', 'confirm'],
    });
    const handlers = makeHandlers({ onUiToolRequest: vi.fn() });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    writeUiRequest(uiDirFor(handlers), {
      callId: 'k-9',
      tool: 'confirm',
      toolInput: { action: 'rm -rf /secret/path' },
    });
    await vi.advanceTimersByTimeAsync(150);
    h.registry.writeToolResult('proj-a', 'k-9', 'The user CONFIRMED. Proceed with the action.');

    const entries = h.audit.entries;
    const ui = entries.filter((e) => e.tool === 'devia_confirm');
    expect(ui.map((e) => e.summary)).toEqual(['request k-9', 'answered:yes k-9']);
    // The action the agent asked about can carry host paths — it must never
    // reach the audit file.
    expect(JSON.stringify(entries)).not.toContain('/secret/path');
  });

  // S-28 T-333: the request file of a blocking call stays on disk until the
  // server reads the answer, so the 100 ms poller sees it many times. Each
  // sighting used to re-run the handler: the card came back after being
  // answered, the kill timer was re-armed forever and the audit flooded.
  describe('a blocking request seen on many poller ticks', () => {
    const blockingBuild = (extras: BuildExtras = {}) =>
      build({ id: 'codex', name: 'Codex' }, {
        config: projectConfig(),
        ...nativeUi(true),
        implementedUiTools: ['ask_user', 'confirm'],
        ...extras,
      });

    it('is surfaced and audited once', async () => {
      const onUiToolRequest = vi.fn();
      const h = blockingBuild();
      const handlers = makeHandlers({ onUiToolRequest });
      h.uc.execute('proj-a', 'do thing', [], handlers);

      writeUiRequest(uiDirFor(handlers), { callId: 'r-1', tool: 'confirm', toolInput: { action: 'x' } });
      await vi.advanceTimersByTimeAsync(650);

      expect(onUiToolRequest).toHaveBeenCalledOnce();
      const requests = h.audit.entries.filter((e) => e.summary === 'request r-1');
      expect(requests).toHaveLength(1);
    });

    it('still kills the run once the timeout passes, counted from the first sighting', async () => {
      const h = blockingBuild();
      const handlers = makeHandlers({ onUiToolRequest: vi.fn() });
      h.uc.execute('proj-a', 'do thing', [], handlers);

      writeUiRequest(uiDirFor(handlers), { callId: 'r-2', tool: 'confirm', toolInput: { action: 'x' } });
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 500);

      expect(h.runner.last().killSpy).toHaveBeenCalledWith('question_timeout');
    });

    it('auto-answers an always-allowed action once', async () => {
      const onUiToolRequest = vi.fn();
      const h = blockingBuild({ isConfirmationGranted: () => true });
      const handlers = makeHandlers({ onUiToolRequest });
      h.uc.execute('proj-a', 'do thing', [], handlers);

      writeUiRequest(uiDirFor(handlers), { callId: 'r-3', tool: 'confirm', toolInput: { action: 'x' } });
      await vi.advanceTimersByTimeAsync(650);

      expect(onUiToolRequest).not.toHaveBeenCalled();
      expect(h.audit.entries.filter((e) => e.summary === 'answered:auto r-3')).toHaveLength(1);
    });

    it('answers unusable arguments once', async () => {
      const onUiToolRequest = vi.fn();
      const h = blockingBuild();
      const handlers = makeHandlers({ onUiToolRequest });
      h.uc.execute('proj-a', 'do thing', [], handlers);

      const dir = uiDirFor(handlers);
      writeUiRequest(dir, { callId: 'r-4', tool: 'confirm', toolInput: { nope: 1 } });
      await vi.advanceTimersByTimeAsync(150);
      // The server consumes the answer and leaves the request in place for a
      // moment; a second error write would race a fresh call.
      fs.rmSync(answerFilePath(dir, 'r-4'), { force: true });
      await vi.advanceTimersByTimeAsync(500);

      expect(onUiToolRequest).not.toHaveBeenCalled();
      expect(fs.existsSync(answerFilePath(dir, 'r-4'))).toBe(false);
    });
  });

  it('runs fine with no audit log injected', async () => {
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(true),
      implementedUiTools: ['ask_user', 'confirm'],
    });
    const handlers = makeHandlers({ onUiToolRequest: vi.fn() });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    writeUiRequest(uiDirFor(handlers), { callId: 'k-10', tool: 'confirm', toolInput: { action: 'x' } });
    await expect(vi.advanceTimersByTimeAsync(150)).resolves.not.toThrow();
  });

  it('surfaces a question a non-Claude agent published through the rendezvous file', async () => {
    const onQuestionAsk = vi.fn();
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(true),
    });
    const handlers = makeHandlers({ onQuestionAsk });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    writeUiRequest(uiDirFor(handlers), {
      callId: 'ask-1',
      tool: 'ask_user',
      toolInput: { questions: [{ question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] }] },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(onQuestionAsk).toHaveBeenCalledOnce();
    expect(onQuestionAsk.mock.calls[0]?.[1]).toBe('¿A o B?');
  });

  it('does not poll for questions when devia-ask was not delivered', async () => {
    const onQuestionAsk = vi.fn();
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(false),
    });
    const handlers = makeHandlers({ onQuestionAsk });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    writeUiRequest(uiDirFor(handlers), {
      callId: 'ask-1',
      tool: 'ask_user',
      toolInput: { questions: [{ question: '¿A o B?', options: [{ label: 'A' }] }] },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(onQuestionAsk).not.toHaveBeenCalled();
  });

  it('routes the answer to the rendezvous file for an agent with no stdin tool-result channel', async () => {
    const onQuestionAsk = vi.fn();
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(true),
    });
    const handlers = makeHandlers({ onQuestionAsk });
    h.uc.execute('proj-a', 'do thing', [], handlers);

    const uiDir = uiDirFor(handlers);
    writeUiRequest(uiDir, {
      callId: 'ask-1',
      tool: 'ask_user',
      toolInput: { questions: [{ question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] }] },
    });
    await vi.advanceTimersByTimeAsync(150);
    h.registry.writeToolResult('proj-a', 'ask-1', 'B');

    expect(readUiAnswer(answerFilePath(uiDir, 'ask-1'))).toEqual({ answer: 'B' });
  });
});

// ── S-32 — devia_send_file: offer, roots and main-side revalidation ─────────

describe('RunInstructionUseCase — devia_send_file (S-32)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-send-file-'));
    fs.mkdirSync(path.join(tmpDir, 'proj-a'), { recursive: true });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function projectConfig(remote: Partial<DeviaConfig['remoteControl']> = {}): FakeConfig {
    const cfg = new FakeConfig(path.join(tmpDir, '.devia-app'));
    cfg.set({
      workspaceRoot: tmpDir,
      remoteControl: { ...cfg.get().remoteControl, ...remote },
    });
    return cfg;
  }

  /** Real injector, so the assertions are on the argv the server gets. */
  const injector = new UiMcpInjector();
  function argvOf(extras: BuildExtras, origin: 'renderer' | 'remote', isolate = false) {
    const seen: Array<{ tools: readonly UiToolName[]; harness: UiServerHarness | undefined; args: readonly string[] }> = [];
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      ...extras,
      uiMcpServer: (dir, tools, harness) => {
        const server = injector.serverConfig(dir, tools, harness);
        seen.push({ tools, harness, args: server.args ?? [] });
        return server;
      },
    });
    const handlers = makeHandlers();
    h.uc.execute('proj-a', 'do thing', [], handlers, 'apply', [], origin, isolate);
    return { h, handlers, seen: seen[0]! };
  }

  function uiDirFor(handlers: ReturnType<typeof makeHandlers>): string {
    const startArg = (handlers.onProcessStart as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { runId: RunId };
    return uiRunDir(startArg.runId);
  }

  it.each([
    ['no relay, remote run', false, 'remote', {}, false],
    ['relay, desktop run, no mirror', true, 'renderer', {}, false],
    ['relay, remote run', true, 'remote', {}, true],
    ['relay, desktop run mirrored', true, 'renderer', { mirrorDesktop: true }, true],
    ['relay, remote run, allowFileSend off', true, 'remote', { allowFileSend: false }, false],
  ] as const)('%s → offered: %s', (_label, connected, origin, remote, offered) => {
    const { seen } = argvOf(
      { config: projectConfig(remote), remoteRelayConnected: () => connected },
      origin,
    );
    expect(seen.tools.includes('send_file')).toBe(offered);
    expect(seen.args.includes('--send-roots')).toBe(offered);
  });

  it('a run without relay keeps the tool set and argv byte-identical', () => {
    const without = argvOf({ config: projectConfig() }, 'renderer').seen;
    const disconnected = argvOf({ config: projectConfig({ mirrorDesktop: true }), remoteRelayConnected: () => false }, 'renderer').seen;
    expect(disconnected.tools).toEqual(without.tools);
    expect(disconnected.harness).toEqual(without.harness);
    expect(disconnected.harness).not.toHaveProperty('sendRoots');
    expect(disconnected.harness).not.toHaveProperty('cwd');
    expect(disconnected.harness).not.toHaveProperty('denyRoots');
    expect(disconnected.args).not.toContain('--deny-roots');
    // argv embeds the per-run dir; everything else must match.
    const norm = (args: readonly string[]) => args.map((a) => (a.includes('devia-ui') ? '<dir>' : a));
    expect(norm(disconnected.args)).toEqual(norm(without.args));
  });

  it('--send-roots carries ONLY the workspace root (never the attachments dir), and --cwd the run cwd', () => {
    const { seen } = argvOf({ config: projectConfig(), remoteRelayConnected: () => true }, 'remote');
    const roots = JSON.parse(seen.args[seen.args.indexOf('--send-roots') + 1]!) as string[];
    expect(roots).toEqual([tmpDir]);
    expect(seen.args[seen.args.indexOf('--cwd') + 1]).toBe(path.join(tmpDir, 'proj-a'));
  });

  it("--deny-roots carries Devia's data dir whenever send_file is offered", () => {
    const { seen } = argvOf({ config: projectConfig(), remoteRelayConnected: () => true }, 'remote');
    expect(JSON.parse(seen.args[seen.args.indexOf('--deny-roots') + 1]!)).toEqual([path.join(tmpDir, '.devia-app')]);
  });

  it('adds the run cwd as a root only when it is a validated live session worktree', () => {
    const isLive = vi.fn(() => true);
    const live = argvOf({
      config: projectConfig(),
      remoteRelayConnected: () => true,
      ensureSessionWorktree: () => ({ ok: true, created: true }),
      isLiveSessionWorktree: isLive,
    }, 'remote', true);
    const cwd = live.h.runner.last().req.cwd;
    expect(cwd).toContain('worktrees');
    expect(isLive).toHaveBeenCalledWith(cwd);
    expect(JSON.parse(live.seen.args[live.seen.args.indexOf('--send-roots') + 1]!)).toEqual([tmpDir, cwd]);

    const notLive = argvOf({
      config: projectConfig(),
      remoteRelayConnected: () => true,
      ensureSessionWorktree: () => ({ ok: true, created: true }),
      isLiveSessionWorktree: () => false,
    }, 'remote', true);
    expect(JSON.parse(notLive.seen.args[notLive.seen.args.indexOf('--send-roots') + 1]!)).toEqual([tmpDir]);
  });

  it('apply-yolo widens nothing', () => {
    const seen: string[][] = [];
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      remoteRelayConnected: () => true,
      uiMcpServer: (dir, tools, harness) => {
        const server = injector.serverConfig(dir, tools, harness);
        seen.push([...(server.args ?? [])]);
        return server;
      },
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply-yolo', [], 'remote');
    const args = seen[0]!;
    expect(JSON.parse(args[args.indexOf('--send-roots') + 1]!)).toEqual([tmpDir]);
  });

  describe('a send request reaching the main process', () => {
    function remoteRun(onUiToolRequest = vi.fn()) {
      const h = build({ id: 'codex', name: 'Codex' }, {
        config: projectConfig(),
        remoteRelayConnected: () => true,
        ...nativeUi(true),
      });
      const order: string[] = [];
      const handlers = makeHandlers({
        onUiToolRequest: vi.fn((...args: unknown[]) => {
          order.push(`ui:${String(args[0])}`);
          (onUiToolRequest as (...a: unknown[]) => void)(...args);
        }),
        onRunFileRejected: vi.fn((r: { name: string }) => { order.push(`rejected:${r.name}`); }),
        onProcessEnd: vi.fn(() => { order.push('end'); }),
      });
      h.uc.execute('proj-a', 'do thing', [], handlers, 'apply', [], 'remote');
      return { h, handlers, onUiToolRequest, order, dir: uiDirFor(handlers), capture: h.runner.last() };
    }
    const send = (dir: string, callId: string, toolInput: Record<string, unknown>) =>
      writeUiRequest(dir, { callId, tool: 'send_file', toolInput, expectsAnswer: false });

    it('is revalidated: the forwarded RunFile comes from the guard, not the request', async () => {
      fs.writeFileSync(path.join(tmpDir, 'proj-a', 'report.pdf'), 'pdf!');
      const { onUiToolRequest, dir } = remoteRun();
      send(dir, 's-1', { path: 'report.pdf', size: 1, mime: 'image/png', name: 'evil.png', as: 'auto', caption: 'Aquí está' });
      await vi.advanceTimersByTimeAsync(150);

      expect(onUiToolRequest).toHaveBeenCalledOnce();
      const [callId, tool, input, , expectsAnswer] = onUiToolRequest.mock.calls[0] as [string, string, unknown, unknown, boolean];
      expect([callId, tool, expectsAnswer]).toEqual(['s-1', 'send_file', false]);
      expect(input).toEqual({
        path: fs.realpathSync.native(path.join(tmpDir, 'proj-a', 'report.pdf')),
        name: 'report.pdf',
        size: 4,
        mime: 'application/pdf',
        kind: 'document',
        caption: 'Aquí está',
        source: 'tool',
        identity: {
          dev: fs.lstatSync(path.join(tmpDir, 'proj-a', 'report.pdf')).dev,
          ino: fs.lstatSync(path.join(tmpDir, 'proj-a', 'report.pdf')).ino,
        },
      });
    });

    it('a main-side rejection is published as file_rejected with source tool', async () => {
      fs.writeFileSync(path.join(tmpDir, 'proj-a', '.envrc'), 'export TOKEN=1');
      const { handlers, capture, dir } = remoteRun();
      send(dir, 's-1', { path: '.envrc' });
      await vi.advanceTimersByTimeAsync(150);

      expect(handlers.onRunFileRejected).toHaveBeenCalledWith(
        { name: '.envrc', reason: 'secret', source: 'tool' },
        capture.req.runId,
      );
    });

    it("refuses a file under Devia's data dir even though the workspace root contains it", async () => {
      const transcript = path.join(tmpDir, '.devia-app', 'agent-logs', 'run.jsonl');
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, '{}');
      const { h, handlers, onUiToolRequest, dir } = remoteRun();
      send(dir, 's-1', { path: transcript });
      await vi.advanceTimersByTimeAsync(150);

      expect(onUiToolRequest).not.toHaveBeenCalled();
      expect(handlers.onRunFileRejected).toHaveBeenCalledWith(
        { name: 'run.jsonl', reason: 'devia_data', source: 'tool' },
        expect.anything(),
      );
      expect(h.audit.entries.map((e) => e.summary)).toContain('rejected:devia_data');
    });

    it('a request written in the last poll interval is still delivered, before end', () => {
      fs.writeFileSync(path.join(tmpDir, 'proj-a', 'report.pdf'), 'pdf!');
      fs.writeFileSync(path.join(tmpDir, 'proj-a', '.env'), 'X=1');
      const { onUiToolRequest, order, dir, capture } = remoteRun();
      // No timer tick: only stop()'s final sweep can see these.
      send(dir, 's-last', { path: 'report.pdf' });
      send(dir, 's-bad', { path: '.env' });
      capture.handlers.onDone(0);

      expect(onUiToolRequest).toHaveBeenCalledWith('s-last', 'send_file', expect.objectContaining({ name: 'report.pdf' }), expect.anything(), false);
      expect(order.indexOf('ui:s-last')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('ui:s-last')).toBeLessThan(order.indexOf('end'));
      expect(order.indexOf('rejected:.env')).toBeLessThan(order.indexOf('end'));
    });

    it('the final sweep leaves blocking requests alone', () => {
      const { onUiToolRequest, dir, capture } = remoteRun();
      writeUiRequest(dir, { callId: 'b-1', tool: 'todo', toolInput: { items: [{ text: 'a' }] }, expectsAnswer: true });
      capture.handlers.onDone(0);
      expect(onUiToolRequest).not.toHaveBeenCalled();
    });

    it('a failing revalidation forwards nothing and audits the rejection', async () => {
      fs.writeFileSync(path.join(tmpDir, 'proj-a', '.env.local'), 'TOKEN=1');
      const outside = path.join(tmpDir, '..', `outside-${path.basename(tmpDir)}.txt`);
      const { h, onUiToolRequest, dir } = remoteRun();
      send(dir, 's-1', { path: '.env.local' });
      // A forged absPath pointing out of the workspace (the agent wrote the JSON by hand).
      send(dir, 's-2', { path: 'fine.txt', absPath: outside });
      await vi.advanceTimersByTimeAsync(150);

      expect(onUiToolRequest).not.toHaveBeenCalled();
      const summaries = h.audit.entries.filter((e) => e.tool === 'devia_send_file').map((e) => e.summary);
      expect(summaries).toEqual(expect.arrayContaining(['rejected:secret', 'rejected:outside_roots']));
      expect(JSON.stringify(h.audit.entries)).not.toContain('TOKEN=1');
    });

    it('refuses the 11th file of a run', async () => {
      for (let i = 0; i < 11; i++) fs.writeFileSync(path.join(tmpDir, 'proj-a', `f${i}.txt`), String(i));
      const { h, onUiToolRequest, dir } = remoteRun();
      for (let i = 0; i < 11; i++) {
        send(dir, `s-${i}`, { path: `f${i}.txt` });
        await vi.advanceTimersByTimeAsync(150);
      }

      expect(onUiToolRequest).toHaveBeenCalledTimes(10);
      const summaries = h.audit.entries.filter((e) => e.tool === 'devia_send_file').map((e) => e.summary);
      expect(summaries.filter((s) => s?.startsWith('accepted'))).toHaveLength(10);
      expect(summaries).toContain('rejected:limit');
    });

    it('is refused when the run was not offered the tool (no relay)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'proj-a', 'a.txt'), 'a');
      const onUiToolRequest = vi.fn();
      const h = build({ id: 'codex', name: 'Codex' }, { config: projectConfig(), ...nativeUi(true) });
      const handlers = makeHandlers({ onUiToolRequest });
      h.uc.execute('proj-a', 'do thing', [], handlers, 'apply', [], 'remote');
      const dir = uiDirFor(handlers);
      send(dir, 's-1', { path: 'a.txt' });
      await vi.advanceTimersByTimeAsync(150);

      expect(onUiToolRequest).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(dir, 's-1.request.json'))).toBe(false);
      expect(h.audit.entries.map((e) => e.summary)).toContain('rejected:not_offered');
    });
  });
});

// ── S-24 — what the system prompt says about asking the user ────────────────

describe('RunInstructionUseCase — UI-tool protocol in the system prompt (S-25)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-ask-prompt-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function projectConfig(): FakeConfig {
    const cfg = new FakeConfig(path.join(tmpDir, '.devia-app'));
    cfg.set({ workspaceRoot: tmpDir });
    return cfg;
  }

  function promptOf(h: Harness): string {
    return ((h.def.buildExtraArgs as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as AgentExtraArgsOptions).systemPrompt ?? '';
  }

  it('announces devia_ask_user when the tool reaches the run', () => {
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      uiMcpServer: () => enabledServer('devia-ui'),
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    const prompt = promptOf(h);
    expect(prompt).toContain('devia_ask_user');
    expect(prompt).not.toContain(UI_FALLBACK);
  });

  it('never mentions the retired AskUserQuestion tool', () => {
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      uiMcpServer: () => enabledServer('devia-ui'),
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    expect(promptOf(h)).not.toContain('AskUserQuestion');
  });

  it('falls back to plain-text questions on a remote (Telegram) run', () => {
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      uiMcpServer: () => enabledServer('devia-ui'),
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'remote');

    const prompt = promptOf(h);
    expect(prompt).toContain(UI_FALLBACK);
    expect(prompt).not.toContain('devia_ask_user tool');
  });

  it('falls back under an enterprise MCP config, where Claude gets no Devia server', () => {
    const h = build({ id: 'claude', name: 'Claude Code' }, {
      config: projectConfig(),
      uiMcpServer: () => enabledServer('devia-ui'),
      enterpriseMcpConfigPresent: () => true,
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    expect(promptOf(h)).toContain(UI_FALLBACK);
  });

  it('falls back for an agent with no MCP config target', () => {
    const h = build({ id: 'deepseek', name: 'DeepSeek' }, {
      config: projectConfig(),
      ...nativeUi(false),
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    expect(promptOf(h)).toContain(UI_FALLBACK);
  });

  it('falls back when writing the agent MCP config fails', () => {
    const h = build({ id: 'codex', name: 'Codex' }, {
      config: projectConfig(),
      ...nativeUi(false),
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers());

    expect(promptOf(h)).toContain(UI_FALLBACK);
  });

  it('tells a remote run to wait for the next message in the SAME session, once', () => {
    const h = build({ id: 'claude', name: 'Claude Code' }, { config: projectConfig() });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'remote');

    const prompt = promptOf(h);
    expect(prompt).toContain(UI_FALLBACK);
    expect(prompt).toContain(REMOTE_PROTOCOL);
    // The two packs must not repeat the same instruction in different words:
    // only the fallback owns the "ask as plain text / end your turn" rule, and
    // the remote pack keeps strictly to what is specific to a chat relay.
    // (Within the fallback the phrase recurs once per missing capability, which
    // is the point — each line covers a different one.)
    expect(REMOTE_PROTOCOL).not.toMatch(/plain text/i);
    expect(REMOTE_PROTOCOL).not.toMatch(/end your turn/i);
  });
});

// ── S-32 T-368 — what the system prompt says about sending files ───────────

describe('RunInstructionUseCase — send-file protocol in the system prompt (S-32 T-368)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-send-prompt-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function projectConfig(remote: Partial<DeviaConfig['remoteControl']> = {}): FakeConfig {
    const cfg = new FakeConfig(path.join(tmpDir, '.devia-app'));
    cfg.set({ workspaceRoot: tmpDir, remoteControl: { ...cfg.get().remoteControl, ...remote } });
    return cfg;
  }

  function promptFor(
    extras: BuildExtras,
    origin: 'renderer' | 'remote',
    mode: 'plan' | 'apply' = 'apply',
  ): string {
    const h = build({ id: 'claude', name: 'Claude Code' }, extras);
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), mode, [], origin);
    return ((h.def.buildExtraArgs as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as AgentExtraArgsOptions).systemPrompt ?? '';
  }

  const delivered = { uiMcpServer: () => enabledServer('devia-ui') };

  it.each([
    ['delivered', delivered],
    ['undelivered', {}],
  ] as const)('a desktop run without relay composes a byte-identical prompt (%s)', (_label, ui) => {
    for (const mode of ['plan', 'apply'] as const) {
      const baseline = promptFor({ config: projectConfig(), ...ui }, 'renderer', mode);
      const disconnected = promptFor(
        { config: projectConfig({ mirrorDesktop: true }), remoteRelayConnected: () => false, ...ui },
        'renderer',
        mode,
      );
      const noMirror = promptFor({ config: projectConfig(), remoteRelayConnected: () => true, ...ui }, 'renderer', mode);
      expect(disconnected).toBe(baseline);
      expect(noMirror).toBe(baseline);
      expect(baseline).not.toContain('outbox/');
      expect(baseline).not.toContain('devia_send_file');
    }
  });

  it('a remote run with the tool announces it, not the outbox, plus the remote bullet', () => {
    const prompt = promptFor({ config: projectConfig(), remoteRelayConnected: () => true, ...delivered }, 'remote');
    expect(prompt).toContain('devia_send_file');
    expect(prompt).not.toContain('outbox/');
    expect(prompt).toContain(REMOTE_SEND_FILE_LINE);
  });

  it('a remote apply run without the tool is pointed at the outbox', () => {
    const prompt = promptFor({ config: projectConfig(), remoteRelayConnected: () => true }, 'remote');
    expect(prompt).not.toContain('devia_send_file');
    expect(prompt).toContain('`outbox/`');
    expect(prompt).toContain(REMOTE_SEND_FILE_LINE);
  });

  it('a remote plan run without the tool promises neither the outbox nor files', () => {
    const prompt = promptFor({ config: projectConfig(), remoteRelayConnected: () => true }, 'remote', 'plan');
    expect(prompt).not.toContain('outbox/');
    expect(prompt).toContain('cannot send files');
    expect(prompt).not.toContain(REMOTE_SEND_FILE_LINE);
  });

  it('a remote run with allowFileSend off says nothing about files', () => {
    const prompt = promptFor(
      { config: projectConfig({ allowFileSend: false }), remoteRelayConnected: () => true },
      'remote',
    );
    expect(prompt).not.toContain('outbox/');
    expect(prompt).not.toContain(REMOTE_SEND_FILE_LINE);
    expect(prompt).toContain(REMOTE_PROTOCOL);
  });

  it('a mirrored desktop run without the tool gets the outbox, not the remote pack', () => {
    const prompt = promptFor(
      { config: projectConfig({ mirrorDesktop: true }), remoteRelayConnected: () => true },
      'renderer',
    );
    expect(prompt).toContain('`outbox/`');
    expect(prompt).not.toContain(REMOTE_PROTOCOL);
  });
});

// ── MCP permission — headless fix, persisted to settings.local.json ─────────
// Devia has no interactive permission approver in its `-p` runtime. The tool
// permission is the single source of truth in the project's
// `.claude/settings.local.json` (`permissions.allow += mcp__<id>`), NOT a
// per-run `--allowedTools` flag — Claude re-reads the file each `-p` turn.

describe('RunInstructionUseCase — MCP permission persisted to settings', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-kanban-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /** Config whose workspaceRoot === tmpDir so the resolved cwd is tmpDir/<proj>. */
  function projectConfig(): FakeConfig {
    const cfg = new FakeConfig(path.join(tmpDir, '.devia-app'));
    cfg.set({ workspaceRoot: tmpDir });
    return cfg;
  }

  function readAllow(projectName: string): string[] {
    const file = path.join(tmpDir, projectName, '.claude', 'settings.local.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions?: { allow?: string[] } };
    return parsed.permissions?.allow ?? [];
  }

  it('writes mcp__devia-kanban into settings.local.json (not --allowedTools) for Claude', () => {
    const h = build(
      { id: 'claude', name: 'Claude Code' },
      { config: projectConfig(), kanbanMcpServer: () => enabledServer('devia-kanban') },
    );
    h.uc.execute('proj-a', 'plan it', [], makeHandlers(), 'plan');

    const args = h.runner.last().req.prepared.args;
    expect(args).toContain('--mcp-config');
    expect(args).not.toContain('--allowedTools');
    expect(readAllow('proj-a')).toContain('mcp__devia-kanban');
  });

  it('grants every user-enabled MCP server in the project settings for Claude', () => {
    const h = build(
      { id: 'claude', name: 'Claude Code' },
      {
        config: projectConfig(),
        mcpServers: makeMcpRegistry([enabledServer('my-server'), enabledServer('other')]),
      },
    );
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply');

    const allow = readAllow('proj-a');
    expect(allow).toContain('mcp__my-server');
    expect(allow).toContain('mcp__other');
    expect(h.runner.last().req.prepared.args).not.toContain('--allowedTools');
  });

  it('leaves the project settings untouched when no MCP server is injected', () => {
    const h = build({ id: 'claude', name: 'Claude Code' }, { config: projectConfig() });
    h.uc.execute('proj-a', 'plan it', [], makeHandlers(), 'plan');

    expect(h.runner.last().req.prepared.args).not.toContain('--allowedTools');
    // S-24: with the PreToolUse hook retired, a run with nothing to grant no
    // longer creates the file at all.
    const file = path.join(tmpDir, 'proj-a', '.claude', 'settings.local.json');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('sweeps the retired AskUserQuestion hook out of a project it already wrote', () => {
    const file = path.join(tmpDir, 'proj-a', '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: 'AskUserQuestion',
          hooks: [{ type: 'command', command: `node "/old/path/ask-user-question-hook.js"` }],
        }],
      },
    }));

    const h = build({ id: 'claude', name: 'Claude Code' }, { config: projectConfig() });
    h.uc.execute('proj-a', 'plan it', [], makeHandlers(), 'plan');

    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: unknown }).hooks).toBeUndefined();
  });

  // ── S-1: devia-memory server + engram block ──────────────────────────────

  it('appends --strict-mcp-config for Claude when memory.blockExternalMemory is true', () => {
    const h = build(
      { id: 'claude', name: 'Claude Code' },
      { config: projectConfig(), kanbanMcpServer: () => enabledServer('devia-kanban') },
    );
    h.uc.execute('proj-a', 'plan it', [], makeHandlers(), 'plan');

    expect(h.runner.last().req.prepared.args).toContain('--strict-mcp-config');
  });

  it('omits --strict-mcp-config when memory.blockExternalMemory is false', () => {
    const cfg = projectConfig();
    cfg.set({ memory: { enabled: true, blockExternalMemory: false, engramImported: false } });
    const h = build(
      { id: 'claude', name: 'Claude Code' },
      { config: cfg, kanbanMcpServer: () => enabledServer('devia-kanban') },
    );
    h.uc.execute('proj-a', 'plan it', [], makeHandlers(), 'plan');

    expect(h.runner.last().req.prepared.args).not.toContain('--strict-mcp-config');
  });

  // T-88: enterprise-managed MCP config carve-out
  it('omits --strict-mcp-config for Claude when an enterprise MCP config is present, even with blockExternalMemory', () => {
    const h = build(
      { id: 'claude', name: 'Claude Code' },
      {
        config: projectConfig(),
        kanbanMcpServer: () => enabledServer('devia-kanban'),
        enterpriseMcpConfigPresent: () => true,
      },
    );
    h.uc.execute('proj-a', 'plan it', [], makeHandlers(), 'plan');

    expect(h.runner.last().req.prepared.args).not.toContain('--strict-mcp-config');
  });

  it('also omits --mcp-config when an enterprise MCP config is present (Claude rejects dynamic MCP config)', () => {
    const h = build(
      { id: 'claude', name: 'Claude Code' },
      {
        config: projectConfig(),
        kanbanMcpServer: () => enabledServer('devia-kanban'),
        enterpriseMcpConfigPresent: () => true,
      },
    );
    h.uc.execute('proj-a', 'plan it', [], makeHandlers(), 'plan');

    // Under enterprise policy Claude forbids BOTH flags — pass neither so the
    // run starts (the org's MCP config governs; Devia's servers aren't injected).
    expect(h.runner.last().req.prepared.args).not.toContain('--mcp-config');
    expect(h.runner.last().req.prepared.args).not.toContain('--strict-mcp-config');
  });

  it('delivers devia-memory via --mcp-config and grants it for Claude when memory.enabled', () => {
    const h = build(
      { id: 'claude', name: 'Claude Code' },
      { config: projectConfig(), memoryMcpServer: () => enabledServer('devia-memory') },
    );
    h.uc.execute('proj-a', 'plan it', [], makeHandlers(), 'plan');

    expect(h.runner.last().req.prepared.args).toContain('--mcp-config');
    expect(readAllow('proj-a')).toContain('mcp__devia-memory');
  });

  it('passes the active agent id to memoryMcpServer and saveMemoryPrompt (S-2 F1.1)', () => {
    const serverCalls: Array<string | undefined> = [];
    const promptCalls: Array<string | undefined> = [];
    const h = build(
      { id: 'claude', name: 'Claude Code' },
      {
        config: projectConfig(),
        memoryMcpServer: (_abs, agentId) => { serverCalls.push(agentId); return enabledServer('devia-memory'); },
        saveMemoryPrompt: (_abs, _content, _sessionId, agentId) => { promptCalls.push(agentId); },
      },
    );
    h.uc.execute('proj-a', 'haz algo', [], makeHandlers());

    expect(serverCalls).toEqual(['claude']);
    expect(promptCalls).toEqual(['claude']);
  });

  it('does NOT deliver devia-memory when memory.enabled is false', () => {
    const cfg = projectConfig();
    cfg.set({ memory: { enabled: false, blockExternalMemory: false, engramImported: false } });
    const h = build(
      { id: 'claude', name: 'Claude Code' },
      { config: cfg, memoryMcpServer: () => enabledServer('devia-memory') },
    );
    h.uc.execute('proj-a', 'plan it', [], makeHandlers(), 'plan');

    const file = path.join(tmpDir, 'proj-a', '.claude', 'settings.local.json');
    const allow = fs.existsSync(file) ? readAllow('proj-a') : [];
    expect(allow).not.toContain('mcp__devia-memory');
  });

  it('injects devia-memory into a non-Claude agent native config when memory.enabled', () => {
    const nativeMcp = nativeDelivery(true);
    const identities: string[] = [];
    const h = build(
      { id: 'gemini', name: 'Gemini CLI' },
      {
        config: projectConfig(),
        memoryMcpServer: (projectAbs) => { identities.push(projectAbs); return enabledServer('devia-memory'); },
        nativeMcp,
      },
    );
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply');

    expect(nativeMcp.deliver).toHaveBeenCalledTimes(1);
    expect(nativeMcp.deliver.mock.calls[0]?.[0]).toBe('gemini');
    expect((nativeMcp.deliver.mock.calls[0]?.[2] as McpServerConfig[]).map((s) => s.id)).toContain('devia-memory');
    expect(identities[0]).toContain('proj-a');
  });
});

// ── E-DSK-13 #313: agent-capability-aware delivery + once-per-session ────────

describe('RunInstructionUseCase — memory delivery (E-DSK-13 #313)', () => {
  // stdin-prepend so the composed system prompt is observable on stdin; a
  // native-config agent so the memory server's delivery is real.
  const stdinDef: Partial<RuntimeAgentDef> = { id: 'gemini', systemPromptStrategy: 'stdin-prepend' };
  const memoryDelivered = (delivers = true): Pick<BuildExtras, 'nativeMcp' | 'memoryMcpServer'> => ({
    nativeMcp: nativeDelivery(delivers),
    memoryMcpServer: () => enabledServer('devia-memory'),
  });

  it('injects the memory protocol when the devia-memory tools reach the agent', () => {
    const h = build(stdinDef, memoryDelivered(true));
    h.uc.execute('proj-a', 'do', [], makeHandlers());
    expect(stdinSystemPromptOf(h.runner.last())).toContain('Devia persistent memory');
  });

  it('omits the memory protocol when the devia-memory tools did not reach the agent', () => {
    const h = build(stdinDef, memoryDelivered(false));
    h.uc.execute('proj-a', 'do', [], makeHandlers());
    expect(stdinSystemPromptOf(h.runner.last())).not.toContain('Devia persistent memory');
  });

  it('pre-injects memory context on the first turn of a session', () => {
    const h = build(stdinDef, {
      memoryContext: () => ({ observations: [], summaries: ['Prior decision: chose X'] }),
    });
    h.uc.execute('proj-a', 'do', [], makeHandlers());
    const sp = stdinSystemPromptOf(h.runner.last());
    expect(sp).toContain('Memory from previous sessions');
    expect(sp).toContain('Prior decision: chose X');
  });

  it('skips memory context on a resumed session but keeps the protocol', () => {
    const h = build(stdinDef, {
      memoryContext: () => ({ observations: [], summaries: ['Prior decision'] }),
      ...memoryDelivered(true),
    });
    // Simulate a resumed agent session OWNED BY the current agent.
    const rec = h.registry.getOrCreate('proj-resumed');
    rec.agentSessionId = 'agent-sess-1';
    rec.agentSessionAgentId = h.def.id;
    h.uc.execute('proj-resumed', 'do', [], makeHandlers());
    const sp = stdinSystemPromptOf(h.runner.last());
    expect(sp).not.toContain('Memory from previous sessions');
    expect(sp).toContain('Devia persistent memory');
  });

  it('does NOT resume a session owned by a different agent — treats it as a first turn', () => {
    const h = build(stdinDef, {
      memoryContext: () => ({ observations: [], summaries: ['Prior decision'] }),
      ...memoryDelivered(true),
    });
    // Stored native session belongs to another agent (e.g. after switching agents).
    const rec = h.registry.getOrCreate('proj-switched');
    rec.agentSessionId = 'other-agent-sess';
    rec.agentSessionAgentId = 'some-other-agent';
    h.uc.execute('proj-switched', 'do', [], makeHandlers());
    const sp = stdinSystemPromptOf(h.runner.last());
    // First turn for the new agent → memory IS injected (no cross-agent resume).
    expect(sp).toContain('Memory from previous sessions');
  });

  it('tags the owning agent id when the agent emits session_started', () => {
    const h = build(stdinDef);
    h.uc.execute('proj-started', 'do', [], makeHandlers());
    h.runner.last().handlers.onOutput?.(
      JSON.stringify({ type: 'session_started', agentSessionId: 'sess-99' }),
    );
    const rec = h.registry.find('proj-started');
    expect(rec?.agentSessionId).toBe('sess-99');
    expect(rec?.agentSessionAgentId).toBe(h.def.id);
  });

  // T-194: a run killed (cancel / question_timeout / crash) after the init line
  // arrived must keep the native session id captured from session_started, so
  // the next turn resumes it instead of starting amnesiac.
  it('keeps agentSessionId after the run dies via onError once session_started arrived', () => {
    const h = build(stdinDef);
    h.uc.execute('proj-killed', 'do', [], makeHandlers());
    const capture = h.runner.last();
    // session_started now arrives from system/init, BEFORE any result.
    capture.handlers.onOutput?.(
      JSON.stringify({ type: 'session_started', agentSessionId: 'sess-init-1' }),
    );
    // The run is then killed by the question-timeout / cancel path → onError,
    // never reaching `result`.
    capture.handlers.onError('cancelled by user', undefined, 'SIGTERM', 'question_timeout');
    const rec = h.registry.find('proj-killed');
    expect(rec?.agentSessionId).toBe('sess-init-1');
    expect(rec?.agentSessionAgentId).toBe(h.def.id);
  });

  it('logs a diagnostic warning when a run dies before any session id was captured', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const h = build(stdinDef);
      h.uc.execute('proj-nosession', 'do', [], makeHandlers());
      // No session_started ever arrived (crash before the init line).
      h.runner.last().handlers.onError('boom');
      const warned = warnSpy.mock.calls.some(
        (c) => String(c[0]).includes('without ever capturing a native session id'),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT warn when a session id was captured before the run died', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const h = build(stdinDef);
      h.uc.execute('proj-ok', 'do', [], makeHandlers());
      const capture = h.runner.last();
      capture.handlers.onOutput?.(
        JSON.stringify({ type: 'session_started', agentSessionId: 'sess-ok-1' }),
      );
      capture.handlers.onError('cancelled by user', undefined, 'SIGTERM', 'user');
      const warned = warnSpy.mock.calls.some(
        (c) => String(c[0]).includes('without ever capturing a native session id'),
      );
      expect(warned).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── S-13 T-153 — per-session worktree cwd interception ──────────────────────

describe('RunInstructionUseCase — worktree cwd interception (S-13 T-153)', () => {
  const PROJECT_CWD = process.platform === 'win32' ? 'C:\\ws\\proj-a' : '/ws/proj-a';

  function harnessWith(flag: boolean, ensure?: (ref: WorktreeRef) => EnsureWorktreeResult) {
    const config = new FakeConfig();
    config.set({ worktreePerSession: flag });
    return build({}, { config, ...(ensure ? { ensureSessionWorktree: ensure } : {}) });
  }

  it('S-3 F1.1: the legacy flag no longer gates — isolateSession alone re-points the cwd', () => {
    const h = harnessWith(false, () => ({ ok: true, created: true }));
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'renderer', true);
    expect(h.runner.last().req.cwd).not.toBe(PROJECT_CWD);
  });

  it('S-3 F3: an isolated run carries the MANDATORY worktree protocol; a base run does not', () => {
    const isolated = harnessWith(true, () => ({ ok: true, created: true }));
    isolated.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'renderer', true);
    const isolatedPrompt = String(
      (isolated.def.buildExtraArgs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.systemPrompt,
    );
    expect(isolatedPrompt).toContain('MANDATORY — isolated session worktree');

    const base = harnessWith(true, () => ({ ok: true, created: true }));
    base.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'renderer', false);
    const basePrompt = String(
      (base.def.buildExtraArgs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.systemPrompt,
    );
    expect(basePrompt).not.toContain('MANDATORY — isolated session worktree');
  });

  it('S-3 F3: remote + isolated → both protocols present', () => {
    const h = harnessWith(true, () => ({ ok: true, created: true }));
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'remote', true);
    const prompt = String(
      (h.def.buildExtraArgs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.systemPrompt,
    );
    expect(prompt).toContain('MANDATORY — isolated session worktree');
    expect(prompt).toContain('Remote session — Telegram chat relay');
  });

  it('flag ON + isolateSession=false (primary) → cwd unchanged', () => {
    const ensure = vi.fn((): EnsureWorktreeResult => ({ ok: true, created: true }));
    const h = harnessWith(true, ensure);
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'renderer', false);
    expect(h.runner.last().req.cwd).toBe(PROJECT_CWD);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('flag ON + isolateSession=true + worktree ok → cwd is the worktreeDir', () => {
    let seen: WorktreeRef | null = null;
    const ensure = (ref: WorktreeRef): EnsureWorktreeResult => {
      seen = ref;
      return { ok: true, created: true };
    };
    const h = harnessWith(true, ensure);
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'renderer', true);
    expect(seen).not.toBeNull();
    expect(seen!.baseProject).toBe(PROJECT_CWD);
    expect(h.runner.last().req.cwd).toBe(seen!.worktreeDir);
    expect(h.runner.last().req.cwd).toContain('worktrees');
  });

  it('isolated run keeps the memory + kanban MCP identity on the BASE checkout (not the worktree)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mem-identity-'));
    try {
      const config = new FakeConfig(path.join(tmp, '.devia-app'));
      const kanbanPaths: string[] = [];
      const memoryPaths: string[] = [];
      const h = build(
        { id: 'claude', name: 'Claude Code' },
        {
          config,
          ensureSessionWorktree: () => ({ ok: true, created: true }),
          kanbanMcpServer: (abs) => { kanbanPaths.push(abs); return enabledServer('devia-kanban'); },
          memoryMcpServer: (abs) => { memoryPaths.push(abs); return enabledServer('devia-memory'); },
        },
      );
      h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'renderer', true);

      expect(h.runner.last().req.cwd).toContain('worktrees');
      expect(kanbanPaths).toEqual([PROJECT_CWD]);
      expect(memoryPaths).toEqual([PROJECT_CWD]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('isolated run keeps the passive memory sinks + native-config memory identity on the BASE checkout', () => {
    const promptPaths: string[] = [];
    const contextPaths: string[] = [];
    const memoryIdentities: string[] = [];
    const nativeMcp = nativeDelivery(true);
    const h = build({ id: 'gemini', name: 'Gemini CLI' }, {
      ensureSessionWorktree: () => ({ ok: true, created: true }),
      saveMemoryPrompt: (abs) => { promptPaths.push(abs); },
      memoryContext: (abs) => { contextPaths.push(abs); return { observations: [], summaries: [] }; },
      memoryMcpServer: (abs) => { memoryIdentities.push(abs); return enabledServer('devia-memory'); },
      nativeMcp,
    });
    h.uc.execute('proj-a', 'do thing', [], makeHandlers(), 'apply', [], 'renderer', true);

    const worktreeCwd = h.runner.last().req.cwd;
    expect(worktreeCwd).toContain('worktrees');
    expect(promptPaths).toEqual([PROJECT_CWD]);
    expect(contextPaths).toEqual([PROJECT_CWD]);
    // The native config file follows the CLI cwd (the worktree); the memory
    // identity stays on the base checkout.
    expect(nativeMcp.deliver.mock.calls[0]?.slice(0, 2)).toEqual(['gemini', worktreeCwd]);
    expect(memoryIdentities).toEqual([PROJECT_CWD]);
  });

  it('flag ON + isolateSession=true + no-commits → falls back to project cwd + emits status', () => {
    const handlers = makeHandlers();
    const h = harnessWith(true, () => ({ ok: false, code: 'no-commits' }));
    h.uc.execute('proj-a', 'do thing', [], handlers, 'apply', [], 'renderer', true);
    expect(h.runner.last().req.cwd).toBe(PROJECT_CWD);
    const outputs = (handlers.onClaudeOutput as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"type":"status"'));
    expect(outputs.some((l) => l.includes('worktree'))).toBe(true);
  });
});

// ── S-2 F2.2 — cross-agent session handoff ─────────────────────────────────

describe('RunInstructionUseCase — cross-agent handoff (S-2 F2.2)', () => {
  const HISTORY = [
    { id: 'u1', role: 'user', text: 'implementa el módulo de pagos' },
    {
      id: 'a1', role: 'assistant', text: 'Listo.', agentId: 'codex',
      toolCalls: [{ id: 't1', name: 'Edit', input: { file_path: '/ws/proj-a/src/pagos.ts' } }],
      events: [{ kind: 'session_started', agentSessionId: 'native-codex-1' }],
    },
  ];

  function seededSessions(messages: unknown[] | 'throw'): SessionStore {
    const base = new FakeSessions();
    return {
      ...base,
      newSessionId: () => 'sess-new',
      isValidSessionId: base.isValidSessionId.bind(base),
      load: (_project: string, _id: string) => {
        if (messages === 'throw') throw new Error('disk exploded');
        return {
          id: 'sess-x', project: 'proj-a', createdAt: 1, updatedAt: 2, messages,
        } as import('../../../../shared/domain/session').PersistedSession;
      },
    } as SessionStore;
  }

  function mismatchedRecord(h: Harness, owner = 'codex'): void {
    const rec = h.registry.getOrCreate('proj-a');
    rec.activeSessionId = 'sess-x';
    rec.agentSessionId = 'native-codex-1';
    rec.agentSessionAgentId = owner;
  }

  function lastSystemPrompt(h: Harness): string {
    const buildExtraArgs = h.def.buildExtraArgs as ReturnType<typeof vi.fn>;
    return String((buildExtraArgs.mock.calls[0]?.[0] as AgentExtraArgsOptions).systemPrompt);
  }

  it('owner mismatch with history → injects the brief into the system prompt and emits the handoff event', () => {
    const events: Array<{ project: string; fromAgentId: string; toAgentId: string; summary: string; runId: RunId }> = [];
    const h = build({}, {
      sessions: seededSessions(HISTORY),
      onSessionHandoff: (e) => events.push(e),
    });
    mismatchedRecord(h);

    h.uc.execute('proj-a', 'sigue con ello', [], makeHandlers());

    const prompt = lastSystemPrompt(h);
    expect(prompt).toContain('Continuación de sesión iniciada con codex');
    expect(prompt).toContain('pagos');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ project: 'proj-a', fromAgentId: 'codex', toAgentId: 'fake-agent' });
    expect(events[0]!.summary).toContain('Continuación de sesión iniciada con codex');
  });

  it('no history → no handoff (no block in prompt, no event)', () => {
    const events: unknown[] = [];
    const h = build({}, { sessions: seededSessions([]), onSessionHandoff: (e) => events.push(e) });
    mismatchedRecord(h);

    h.uc.execute('proj-a', 'sigue', [], makeHandlers());

    expect(lastSystemPrompt(h)).not.toContain('Continuación de sesión');
    expect(events).toHaveLength(0);
  });

  it('same owner agent → no handoff', () => {
    const events: unknown[] = [];
    const h = build({}, { sessions: seededSessions(HISTORY), onSessionHandoff: (e) => events.push(e) });
    mismatchedRecord(h, 'fake-agent');

    h.uc.execute('proj-a', 'sigue', [], makeHandlers());

    expect(lastSystemPrompt(h)).not.toContain('Continuación de sesión');
    expect(events).toHaveLength(0);
  });

  it('a sessions.load failure never aborts the run', () => {
    const h = build({}, { sessions: seededSessions('throw') });
    mismatchedRecord(h);

    expect(() => h.uc.execute('proj-a', 'sigue', [], makeHandlers())).not.toThrow();
    expect(h.runner.captured).toHaveLength(1);
  });

  it('records the handoff in memory with the DESTINATION agent id and the source cited', () => {
    const calls: Array<{ content: string; sessionId?: string; agentId?: string }> = [];
    const h = build({}, {
      sessions: seededSessions(HISTORY),
      saveMemoryHandoff: (_abs, content, sessionId, agentId) => {
        calls.push({ content, ...(sessionId !== undefined && { sessionId }), ...(agentId !== undefined && { agentId }) });
      },
    });
    mismatchedRecord(h);

    h.uc.execute('proj-a', 'sigue', [], makeHandlers());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe('fake-agent');
    expect(calls[0]!.sessionId).toBe('sess-x');
    expect(calls[0]!.content).toContain('de codex a fake-agent');
  });

  it('memory disabled → no memory record but the prompt injection and event still happen', () => {
    const cfg = new FakeConfig();
    cfg.set({ memory: { enabled: false, blockExternalMemory: false, engramImported: false } });
    const memoryCalls: unknown[] = [];
    const events: unknown[] = [];
    const h = build({}, {
      config: cfg,
      sessions: seededSessions(HISTORY),
      saveMemoryHandoff: (...args) => memoryCalls.push(args),
      onSessionHandoff: (e) => events.push(e),
    });
    mismatchedRecord(h);

    h.uc.execute('proj-a', 'sigue', [], makeHandlers());

    expect(memoryCalls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(lastSystemPrompt(h)).toContain('Continuación de sesión iniciada con codex');
  });
});

describe('RunInstructionUseCase — LLM-enriched handoff (S-2 F2.3)', () => {
  const F23_HISTORY = [
    { id: 'u1', role: 'user', text: 'implementa el módulo de pagos' },
    { id: 'a1', role: 'assistant', text: 'Listo.', agentId: 'codex' },
  ];

  function seeded(): SessionStore {
    const base = new FakeSessions();
    return {
      ...base,
      newSessionId: () => 'sess-new',
      isValidSessionId: base.isValidSessionId.bind(base),
      load: () => ({
        id: 'sess-x', project: 'proj-a', createdAt: 1, updatedAt: 2, messages: F23_HISTORY,
      } as import('../../../../shared/domain/session').PersistedSession),
    } as unknown as SessionStore;
  }

  function mismatch(h: Harness): void {
    const rec = h.registry.getOrCreate('proj-a');
    rec.activeSessionId = 'sess-x';
    rec.agentSessionId = 'native-codex-1';
    rec.agentSessionAgentId = 'codex';
  }

  function promptOf(h: Harness): string {
    const buildExtraArgs = h.def.buildExtraArgs as ReturnType<typeof vi.fn>;
    return String((buildExtraArgs.mock.calls[0]?.[0] as AgentExtraArgsOptions).systemPrompt);
  }

  it('a cached summary enriches the brief — compressed body AND verbatim tail present', () => {
    const calls: Array<[string, string]> = [];
    const h = build({}, {
      sessions: seeded(),
      handoffSummary: (identity, sessionId) => { calls.push([identity, sessionId]); return 'Resolved: pagos.'; },
    });
    mismatch(h);

    h.uc.execute('proj-a', 'sigue', [], makeHandlers());

    expect(calls).toEqual([['proj-a', 'sess-x']]);
    const prompt = promptOf(h);
    expect(prompt).toContain('**Resumen de la sesión:**\nResolved: pagos.');
    expect(prompt).toContain('**Últimos intercambios:**');
    expect(prompt).toContain('implementa el módulo de pagos');
  });

  it('a cache miss (null) yields the deterministic brief, byte-identical to F2.2', () => {
    const withMiss = build({}, { sessions: seeded(), handoffSummary: () => null });
    mismatch(withMiss);
    withMiss.uc.execute('proj-a', 'sigue', [], makeHandlers());

    const withoutDep = build({}, { sessions: seeded() });
    mismatch(withoutDep);
    withoutDep.uc.execute('proj-a', 'sigue', [], makeHandlers());

    expect(promptOf(withMiss)).toBe(promptOf(withoutDep));
    expect(promptOf(withMiss)).not.toContain('**Resumen de la sesión:**');
  });

  it('no handoff (same owner) never consults the summary cache', () => {
    const spy = vi.fn(() => 'never');
    const h = build({}, { sessions: seeded(), handoffSummary: spy });
    const rec = h.registry.getOrCreate('proj-a');
    rec.activeSessionId = 'sess-x';
    rec.agentSessionId = 'native-1';
    rec.agentSessionAgentId = 'fake-agent';

    h.uc.execute('proj-a', 'sigue', [], makeHandlers());

    expect(spy).not.toHaveBeenCalled();
  });

  it('prefers the FRESH rich summary from the previous agent over the F2.3 cache (F3.4)', () => {
    const richCalls: unknown[][] = [];
    const h = build({}, {
      sessions: seeded(),
      handoffSummary: () => 'comprimido',
      recentHandoffSummary: (...args) => { richCalls.push(args); return 'Resumen rico del agente anterior.'; },
    });
    mismatch(h);

    h.uc.execute('proj-a', 'sigue', [], makeHandlers());

    expect(richCalls[0]?.[1]).toBe('sess-x');
    expect(richCalls[0]?.[2]).toBe('codex');
    const prompt = promptOf(h);
    expect(prompt).toContain('**Resumen de la sesión:**\nResumen rico del agente anterior.');
    expect(prompt).not.toContain('comprimido');
  });
});

// ── S-2 F3.4 — agent override per run ───────────────────────────────────────

describe('RunInstructionUseCase — agentIdOverride (S-2 F3.4)', () => {
  const NO_MODE = undefined;
  const NO_PACKS = undefined;
  const NO_ORIGIN = undefined;
  const NO_ISOLATE = undefined;
  const NO_RUNKEY = undefined;
  const NO_SESSION = undefined;

  function executeWithOverride(h: Harness, override: string | undefined, handlers = makeHandlers()) {
    h.uc.execute('proj-a', 'genera resumen', [], handlers, NO_MODE, NO_PACKS, NO_ORIGIN, NO_ISOLATE, NO_RUNKEY, NO_SESSION, override);
    return handlers;
  }

  it('an unknown / non-executable agent rejects as a normal run error', () => {
    const h = build();
    const handlers = executeWithOverride(h, 'codex'); // FakeRegistry only knows fake-agent

    expect(h.runner.captured).toHaveLength(0);
    const end = (handlers.onProcessEnd as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { code: number; error?: string };
    expect(end.code).toBe(1);
    expect(end.error).toContain('codex');
  });

  it('an override matching a registered agent runs normally', () => {
    const h = build();
    executeWithOverride(h, 'fake-agent');
    expect(h.runner.captured).toHaveLength(1);
  });

  it('override runs skip passive memory capture (prompt is internal; auto summary would clobber the rich one)', () => {
    const promptCalls: unknown[] = [];
    const summaryCalls: unknown[] = [];
    const h = build({}, {
      saveMemoryPrompt: (...args) => promptCalls.push(args),
    });
    // Drive a full successful run with tool use so the auto summary WOULD fire.
    const uc = new RunInstructionUseCase({
      config: new FakeConfig(),
      sessions: new FakeSessions(),
      state: new FakeState(),
      registry: h.registry,
      runner: h.runner,
      agents: new FakeRegistry(h.def),
      mappers: makeMappers(),
      attachments: new FakeAttachments(),
      outbox: new FakeOutbox(),
      tech: new FakeTech(),
      auditLog: new RecordingAuditLog(),
      saveMemoryPrompt: (...args) => promptCalls.push(args),
      saveMemorySummary: (...args) => summaryCalls.push(args),
    });
    uc.execute('proj-a', 'genera resumen', [], makeHandlers(), NO_MODE, NO_PACKS, NO_ORIGIN, NO_ISOLATE, NO_RUNKEY, NO_SESSION, 'fake-agent');
    const capture = h.runner.last();
    emitToolUse(capture, 't1', 'Bash', {});
    capture.handlers.onDone(0);

    expect(promptCalls).toHaveLength(0);
    expect(summaryCalls).toHaveLength(0);
  });
});

// ── S-19 F0.3 — transcript replay for continuity:'replay' agents ────────────

describe("RunInstructionUseCase — transcript replay (S-19 F0.3)", () => {
  const prior: ChatMessage[] = [
    { id: 'u1', role: 'user', text: 'añade un botón de logout' },
    { id: 'a1', role: 'assistant', text: 'hecho, lo puse en el header' },
  ];

  it('re-seeds the prior transcript into the prompt for a replay agent', () => {
    const sessions = new SessionsWithHistory(prior);
    const h = build({ continuity: 'replay', systemPromptStrategy: 'stdin-prepend' }, { sessions });
    h.uc.execute('proj-a', '¿qué te pedí al principio?', [], makeHandlers());

    const prompt = stdinPromptOf(h.runner.last());
    expect(prompt).toContain('Conversación previa');
    expect(prompt).toContain('añade un botón de logout');
    expect(prompt).toContain('## Mensaje actual del usuario');
    expect(prompt).toContain('¿qué te pedí al principio?');
  });

  it('does NOT re-seed for a native-resume agent — instruction is byte-identical', () => {
    const sessions = new SessionsWithHistory(prior);
    const h = build({ systemPromptStrategy: 'stdin-prepend' }, { sessions });
    h.uc.execute('proj-a', 'hola', [], makeHandlers());
    expect(stdinPromptOf(h.runner.last())).toBe('hola');
  });

  it('does NOT re-seed a replay agent when the session has no prior messages', () => {
    const sessions = new SessionsWithHistory([]);
    const h = build({ continuity: 'replay', systemPromptStrategy: 'stdin-prepend' }, { sessions });
    h.uc.execute('proj-a', 'primer turno', [], makeHandlers());
    expect(stdinPromptOf(h.runner.last())).toBe('primer turno');
  });
});

// ── S-19 F2.3 — per-run devia-kanban injection for non-Claude agents ────────

describe('RunInstructionUseCase — kanban MCP injection (S-19 F2.3)', () => {
  it('delivers devia-kanban to a native-config agent (identity base, file cwd)', () => {
    const nativeMcp = nativeDelivery(true);
    const identities: string[] = [];
    const h = build({ id: 'gemini' }, {
      kanbanMcpServer: (abs) => { identities.push(abs); return enabledServer('devia-kanban'); },
      nativeMcp,
    });
    h.uc.execute('proj-a', 'hola', [], makeHandlers());
    expect(nativeMcp.deliver).toHaveBeenCalledTimes(1);
    const [agentId, cwd, servers] = nativeMcp.deliver.mock.calls[0] as [string, string, McpServerConfig[]];
    expect(agentId).toBe('gemini');
    expect(servers.map((s) => s.id)).toContain('devia-kanban');
    // No worktree isolation here, so identity === config location.
    expect(identities[0]).toBe(cwd);
  });

  it('does NOT write a native config for Claude (kanban rides --mcp-config)', () => {
    const nativeMcp = nativeDelivery(true);
    const h = build({ id: 'claude', systemPromptStrategy: 'argv' }, {
      kanbanMcpServer: () => enabledServer('devia-kanban'),
      nativeMcp,
    });
    h.uc.execute('proj-a', 'hola', [], makeHandlers());
    expect(nativeMcp.deliver).not.toHaveBeenCalled();
  });
});

// ── S-30: dialogs the agent raises natively (pi extension UI, ACP permission) ──

describe('RunInstructionUseCase — native agent dialogs (S-30)', () => {
  it('draws a native confirm as a confirm card and answers through the agent channel', () => {
    const onUiToolRequest = vi.fn();
    const h = build({ id: 'pi', name: 'Pi' });
    h.uc.execute('proj-a', 'go', [], makeHandlers({ onUiToolRequest }));
    const capture = h.runner.last();

    expect(capture.handlers.onUiRequest({ callId: 'c1', kind: 'confirm', title: 'Delete build/?' })).toBe(true);
    expect(onUiToolRequest).toHaveBeenCalledWith('c1', 'confirm', { action: 'Delete build/?' }, expect.any(String), true);

    h.registry.writeToolResult('proj-a', 'c1', 'yes');
    expect(capture.answerSpy).toHaveBeenCalledWith('c1', { kind: 'confirm', confirmed: true });
  });

  it('auto-confirms an action the user already allowed, without drawing a card', () => {
    const onUiToolRequest = vi.fn();
    const h = build({ id: 'pi', name: 'Pi' }, { isConfirmationGranted: () => true });
    h.uc.execute('proj-a', 'go', [], makeHandlers({ onUiToolRequest }));
    const capture = h.runner.last();

    capture.handlers.onUiRequest({ callId: 'c2', kind: 'confirm', title: 'npm install' });
    expect(onUiToolRequest).not.toHaveBeenCalled();
    expect(capture.answerSpy).toHaveBeenCalledWith('c2', { kind: 'confirm', confirmed: true });
  });

  it('draws a native select as a question with options and returns the chosen value', () => {
    const onQuestionAsk = vi.fn();
    const h = build({ id: 'pi', name: 'Pi' });
    h.uc.execute('proj-a', 'go', [], makeHandlers({ onQuestionAsk }));
    const capture = h.runner.last();

    capture.handlers.onUiRequest({
      callId: 's1', kind: 'select', title: 'Which env?',
      options: [{ id: 'dev', label: 'dev' }, { id: 'prod', label: 'prod', description: 'careful' }],
    });
    expect(onQuestionAsk).toHaveBeenCalledWith('s1', 'Which env?', expect.any(String), [
      { label: 'dev' },
      { label: 'prod', description: 'careful' },
    ]);
    h.registry.writeToolResult('proj-a', 's1', 'prod');
    expect(capture.answerSpy).toHaveBeenCalledWith('s1', { kind: 'select', value: 'prod' });
  });

  it('maps a cancelled answer to a cancel', () => {
    const h = build({ id: 'pi', name: 'Pi' });
    h.uc.execute('proj-a', 'go', [], makeHandlers({ onQuestionAsk: vi.fn() }));
    const capture = h.runner.last();
    capture.handlers.onUiRequest({ callId: 'i1', kind: 'input', title: 'Name?' });
    h.registry.writeToolResult('proj-a', 'i1', 'cancelled');
    expect(capture.answerSpy).toHaveBeenCalledWith('i1', { kind: 'cancel' });
  });

  it('routes an ACP permission request through the question card and answers with the chosen label', () => {
    const onQuestionAsk = vi.fn();
    const h = build({ id: 'kimi', name: 'Kimi' });
    h.uc.execute('proj-a', 'go', [], makeHandlers({ onQuestionAsk }));
    const capture = h.runner.last();

    capture.handlers.onUiRequest({
      callId: 'p1', kind: 'select', purpose: 'permission', title: 'Run rm?',
      options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
    });
    expect(onQuestionAsk).toHaveBeenCalledTimes(1);
    h.registry.writeToolResult('proj-a', 'p1', 'Allow');
    expect(capture.answerSpy).toHaveBeenCalledWith('p1', { kind: 'select', value: 'Allow' });
  });

  it('lets the session apply its headless default when nothing can draw the card', () => {
    const h = build({ id: 'pi', name: 'Pi' });
    const { onQuestionAsk: _q, onUiToolRequest: _u, ...noCards } = makeHandlers();
    h.uc.execute('proj-a', 'go', [], noCards);
    expect(h.runner.last().handlers.onUiRequest({ callId: 'x', kind: 'input', title: 'Name?' })).toBe(false);
  });

  it('audits tool calls of every agent, not only Claude', () => {
    const h = build({ id: 'opencode', name: 'OpenCode' });
    h.uc.execute('proj-a', 'go', [], makeHandlers());
    emitToolUse(h.runner.last(), 't-1', 'bash', { command: 'ls' });
    expect(h.audit.entries.map((e) => e.tool)).toContain('bash');
  });
});

describe('RunInstructionUseCase — duplicate tool_use (S-30 T-353 regression)', () => {
  it('forwards a repeated tool_use to the renderer but audits it once', () => {
    const handlers = makeHandlers();
    const h = build({ id: 'claude', name: 'Claude Code' });
    h.uc.execute('proj-a', 'go', [], handlers);
    const capture = h.runner.last();
    emitToolUse(capture, 't-1', 'Bash', { command: 'ls' });
    emitToolUse(capture, 't-1', 'Bash', { command: 'ls' }); // Claude's final wrapper repeats it
    const forwarded = (handlers.onClaudeOutput as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0])).filter((l) => l.includes('"type":"tool_use"'));
    expect(forwarded).toHaveLength(2);
    expect(h.audit.entries.filter((e) => e.tool === 'Bash')).toHaveLength(1);
  });
});

// ── S-32 T-367 — the outbox as a fallback channel to the remote chat ───────

describe('RunInstructionUseCase — outbox flush (S-32 T-367)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-outbox-run-'));
    fs.mkdirSync(path.join(tmpDir, 'proj-a', 'outbox'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(opts: { connected?: boolean; isolate?: boolean; origin?: 'renderer' | 'remote' } = {}) {
    const cfg = new FakeConfig(path.join(tmpDir, '.devia-app'));
    cfg.set({ workspaceRoot: tmpDir });
    const order: string[] = [];
    const handlers = makeHandlers({
      onProcessEnd: vi.fn(() => { order.push('end'); }),
      onOutboxFile: vi.fn((f) => { order.push(`outbox:${f.name}`); }),
      onRunFile: vi.fn((f) => { order.push(`file:${f.name}`); }),
      onRunFileRejected: vi.fn((r) => { order.push(`rejected:${r.name}`); }),
    });
    const h = build({}, {
      config: cfg,
      outbox: createOutboxFlusher(cfg),
      ...(opts.connected !== undefined && { remoteRelayConnected: () => opts.connected! }),
      ...(opts.isolate && {
        ensureSessionWorktree: (ref: WorktreeRef) => {
          fs.mkdirSync(path.join(ref.worktreeDir, 'outbox'), { recursive: true });
          return { ok: true as const, created: true };
        },
        isLiveSessionWorktree: () => true,
      }),
    });
    h.uc.execute('proj-a', 'do thing', [], handlers, 'apply', [], opts.origin ?? 'remote', opts.isolate ?? false);
    return { h, handlers, order, capture: h.runner.last() };
  }
  const outboxOf = (dir: string) => path.join(dir, 'outbox');
  const archiveDir = () => path.join(tmpDir, '.devia-app', 'outbox-archive');

  it('flushes BEFORE onProcessEnd on a clean exit; the renderer card still follows the end', () => {
    const { order, capture } = run({ connected: true });
    fs.writeFileSync(path.join(tmpDir, 'proj-a', 'outbox', 'report.pdf'), 'pdf!');
    capture.handlers.onDone(0);
    expect(order).toEqual(['file:report.pdf', 'end', 'outbox:report.pdf']);
  });

  it('flushes on onError too', () => {
    const { order, capture, handlers } = run({ connected: true });
    fs.writeFileSync(path.join(tmpDir, 'proj-a', 'outbox', 'a.txt'), 'a');
    capture.handlers.onError('boom');
    expect(order).toEqual(['file:a.txt', 'end', 'outbox:a.txt']);
    expect(fs.readdirSync(outboxOf(path.join(tmpDir, 'proj-a')))).toEqual([]);
    const file = (handlers.onOutboxFile as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { project: string; size: number; mime: string };
    expect(file).toMatchObject({ project: 'proj-a', size: 1, mime: 'text/plain' });
  });

  it('publishes a RunFile with source outbox pointing at the ARCHIVED copy', () => {
    const { capture, handlers } = run({ connected: true });
    fs.writeFileSync(path.join(tmpDir, 'proj-a', 'outbox', 'report.pdf'), 'pdf!');
    capture.handlers.onDone(0);
    const onRunFile = handlers.onRunFile as ReturnType<typeof vi.fn>;
    expect(onRunFile).toHaveBeenCalledOnce();
    const [file, runId] = onRunFile.mock.calls[0] as [Record<string, unknown>, RunId];
    expect(runId).toBe(capture.req.runId);
    expect(file).toMatchObject({ name: 'report.pdf', size: 4, mime: 'application/pdf', kind: 'document', source: 'outbox' });
    expect(path.dirname(file['path'] as string)).toBe(archiveDir());
    expect(fs.readFileSync(file['path'] as string, 'utf8')).toBe('pdf!');
    // The identity admitted on outbox/report.pdf survives the rename.
    const archived = fs.lstatSync(file['path'] as string);
    expect(file['identity']).toEqual({ dev: archived.dev, ino: archived.ino });
  });

  it('publishes nothing when the run cannot send files, but archives and reports to the renderer', () => {
    const { capture, handlers, h } = run({ connected: false });
    fs.writeFileSync(path.join(tmpDir, 'proj-a', 'outbox', 'report.pdf'), 'pdf!');
    capture.handlers.onDone(0);
    expect(handlers.onRunFile).not.toHaveBeenCalled();
    expect(handlers.onRunFileRejected).not.toHaveBeenCalled();
    expect(handlers.onOutboxFile).toHaveBeenCalledOnce();
    expect(fs.readdirSync(archiveDir())).toHaveLength(1);
    expect(h.audit.entries.filter((e) => e.tool === 'devia_send_file')).toEqual([]);
  });

  it('a secret file in the outbox is archived but never published', () => {
    const { capture, handlers, h } = run({ connected: true });
    fs.writeFileSync(path.join(tmpDir, 'proj-a', 'outbox', '.env'), 'TOKEN=1');
    capture.handlers.onDone(0);
    expect(handlers.onRunFile).not.toHaveBeenCalled();
    expect(handlers.onRunFileRejected).toHaveBeenCalledWith(
      { name: '.env', reason: 'secret', source: 'outbox' },
      capture.req.runId,
    );
    expect(handlers.onOutboxFile).toHaveBeenCalledOnce();
    expect(fs.readdirSync(archiveDir())).toHaveLength(1);
    expect(h.audit.entries.map((e) => e.summary)).toContain('rejected:secret');
    expect(JSON.stringify(h.audit.entries)).not.toContain('TOKEN=1');
  });

  it('flushes the outbox of the session worktree in an isolated pane', () => {
    const { capture, handlers } = run({ connected: true, isolate: true });
    const cwd = capture.req.cwd;
    expect(cwd).toContain('worktrees');
    fs.writeFileSync(path.join(outboxOf(cwd), 'shot.png'), 'png');
    fs.writeFileSync(path.join(tmpDir, 'proj-a', 'outbox', 'base.txt'), 'base');
    capture.handlers.onDone(0);
    const names = (handlers.onOutboxFile as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toEqual(['shot.png']);
    expect(handlers.onRunFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'shot.png', kind: 'photo' }), capture.req.runId);
    expect(fs.existsSync(path.join(tmpDir, 'proj-a', 'outbox', 'base.txt'))).toBe(true);
  });
});
