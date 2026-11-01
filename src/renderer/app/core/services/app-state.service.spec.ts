/**
 * S-1 T-1 — Footer-derived computed signals on AppStateService.
 *
 * Tests cover: activeModel, contextUsageTokens, contextWindowTokens,
 * contextPct, sessionCostUsd.
 *
 * AppStateService uses Angular DI (inject()) and requires TestBed.
 * We skip init() entirely and drive signals directly to keep tests
 * synchronous and focused on computed logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { AppStateService, transcriptQuestionId } from './app-state.service';
import { ElectronApiService } from './electron-api.service';
import { ToastService } from './toast.service';
import type { ChatMessage } from '../../../../shared/domain/chat';
import type { DeviaConfigView, ProcessEndEvent } from '../../../types/devia';

// ── Minimal stubs ──────────────────────────────────────────────────────────

const noop = (): void => undefined;

const mockApi: Partial<ElectronApiService> = {
  platform: 'linux',
  isWSL: false,
  onClaudeOutput: noop as any,
  onProcessStart: noop as any,
  onProcessEnd: noop as any,
  onSessionHandoff: noop as any,
  onSessionReset: noop as any,
  onAutoResumeScheduled: noop as any,
  onAutoResumeCancelled: noop as any,
  onComposeStart: noop as any,
  onComposeOutput: noop as any,
  onComposeEnd: noop as any,
  onOutboxFile: noop as any,
  onCloneStart: noop as any,
  onCloneOutput: noop as any,
  onCloneEnd: noop as any,
  onGitInfoChanged: noop as any,
  onConfigChanged: noop as any,
  onNotificationClick: noop as any,
  onAgentChanged: noop as any,
  onQueueChanged: noop as any,
  onQueueDispatched: noop as any,
  onTerminalData: noop as any,
  onTerminalExit: noop as any,
  onQuestionAsk: noop as any,
  onDiffSnapshot: noop as any,
  onAgentsDetected: noop as any,
  onSkillRegistryChanged: noop as any,
  onMcpListChanged: noop as any,
  onSubAgentsChanged: noop as any,
  onKanbanChanged: noop as any,
  onAgentWake: noop as any,
  onSddNotification: noop as any,
  onRemoteControlStatus: noop as any,
  onRemoteSelectProject: noop as any,
  onRunModeChanged: noop as any,
  getRunModes: (() => Promise.resolve([])) as any,
  setRunModeRemote: (() => Promise.resolve()) as any,
};

const mockToast: Partial<ToastService> = {
  show: vi.fn(),
};

function makeConfig(overrides: Partial<DeviaConfigView> = {}): DeviaConfigView {
  return {
    workspaceRoot: '/ws',
    ignoreFolders: [],
    agentId: 'claude',
    agentModels: { claude: { model: 'claude-opus-4-7' } },
    agentCliEnv: {},
    agentToolPolicy: {},
    memory: { enabled: true, blockExternalMemory: true, engramImported: false },
    remoteControl: {
      allowShell: false,
      mirrorDesktop: false,
      allowFileSend: true,
      telegram: { enabled: false, botToken: '', chatId: '' },
    },
    configPath: '/cfg',
    hasWorkspace: true,
    ...overrides,
  } as DeviaConfigView;
}

function makeAssistantMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: 'assistant',
    text: '',
    ...overrides,
  } as ChatMessage;
}

// ── Setup ──────────────────────────────────────────────────────────────────

describe('AppStateService — footer computed signals (S-1 T-1)', () => {
  let service: AppStateService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();
    service = TestBed.inject(AppStateService);
  });

  // ── activeModel ───────────────────────────────────────────────────────────

  describe('activeModel', () => {
    it('returns null when no project is selected', () => {
      service['config'].set(makeConfig());
      service['selectedProject'].set(null);
      expect(service.activeModel()).toBeNull();
    });

    it('falls back to config when no chats and no stream', () => {
      service['config'].set(makeConfig({
        agentId: 'claude',
        agentModels: { claude: { model: 'claude-opus-4-7' } },
      }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      expect(service.activeModel()).toBe('claude-opus-4-7');
    });

    it('prefers the last assistant message model over config fallback', () => {
      service['config'].set(makeConfig({ agentModels: { claude: { model: 'claude-haiku-4-5' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ model: 'claude-sonnet-4-6' }),
        makeAssistantMsg({ model: 'claude-opus-4-7' }),
      ]]]));
      expect(service.activeModel()).toBe('claude-opus-4-7');
    });

    it('skips assistant messages without a model field', () => {
      service['config'].set(makeConfig({ agentModels: { claude: { model: 'claude-haiku-4-5' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ model: 'claude-sonnet-4-6' }),
        makeAssistantMsg(),
      ]]]));
      expect(service.activeModel()).toBe('claude-sonnet-4-6');
    });

    it('prioritises active stream model over chat history', () => {
      service['config'].set(makeConfig());
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ model: 'claude-haiku-4-5' }),
      ]]]));
      service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({ model: 'claude-opus-4-7', streaming: true })]]));
      expect(service.activeModel()).toBe('claude-opus-4-7');
    });

    it('falls back to chat history when stream has no model', () => {
      service['config'].set(makeConfig({ agentModels: { claude: { model: 'claude-haiku-4-5' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ model: 'claude-sonnet-4-6' }),
      ]]]));
      service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({ streaming: true })]]));
      expect(service.activeModel()).toBe('claude-sonnet-4-6');
    });

    it('returns null when config has no model for the current agentId', () => {
      service['config'].set(makeConfig({ agentModels: {} }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      expect(service.activeModel()).toBeNull();
    });
  });

  // ── contextUsageTokens ────────────────────────────────────────────────────

  describe('contextUsageTokens', () => {
    it('returns null when no project selected', () => {
      service['selectedProject'].set(null);
      expect(service.contextUsageTokens()).toBeNull();
    });

    it('returns null when no messages with usage', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [makeAssistantMsg()]]]));
      expect(service.contextUsageTokens()).toBeNull();
    });

    it('sums inputTokens + cachedInputTokens from last assistant usage', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { inputTokens: 1000, cachedInputTokens: 200 } }),
      ]]]));
      expect(service.contextUsageTokens()).toBe(1200);
    });

    it('treats undefined cachedInputTokens as 0 when inputTokens is defined', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { inputTokens: 500 } }),
      ]]]));
      expect(service.contextUsageTokens()).toBe(500);
    });

    it('returns null from stream when both inputTokens and cachedInputTokens are undefined', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({
        streaming: true,
        usage: { outputTokens: 50 },
      })]]));
      expect(service.contextUsageTokens()).toBeNull();
    });

    it('reads from active stream when it has inputTokens', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({
        streaming: true,
        usage: { inputTokens: 800, cachedInputTokens: 100 },
      })]]));
      expect(service.contextUsageTokens()).toBe(900);
    });

    it('picks the last assistant message with usage when multiple exist', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { inputTokens: 300 } }),
        makeAssistantMsg({ usage: { inputTokens: 700, cachedInputTokens: 50 } }),
      ]]]));
      expect(service.contextUsageTokens()).toBe(750);
    });
  });

  // ── contextWindowTokens ───────────────────────────────────────────────────

  describe('contextWindowTokens', () => {
    it('returns null when config is null', () => {
      service['config'].set(null);
      expect(service.contextWindowTokens()).toBeNull();
    });

    it('resolves via getModelContextLength for a known claude model', () => {
      service['config'].set(makeConfig({ agentId: 'claude', agentModels: { claude: { model: 'claude-opus-4-7' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      expect(service.contextWindowTokens()).toBe(200_000);
    });

    it('resolves via the cliId-default fallback when model is unknown', () => {
      service['config'].set(makeConfig({ agentId: 'claude', agentModels: { claude: { model: 'claude-unknown-model' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      expect(service.contextWindowTokens()).toBe(200_000);
    });

    it('resolves for gemini-2.5-pro', () => {
      service['config'].set(makeConfig({ agentId: 'gemini', agentModels: { gemini: { model: 'gemini-2.5-pro' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      expect(service.contextWindowTokens()).toBe(1_048_576);
    });

    it('prefers the CLI-reported contextWindow on the active stream over the static table', () => {
      service['config'].set(makeConfig({ agentId: 'claude', agentModels: { claude: { model: 'claude-opus-4-7' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      service['assistantStreams'].set(new Map([['/tmp/p', {
        id: 'stream-1', role: 'assistant', text: '', tools: [], streaming: true,
        usage: { inputTokens: 1, contextWindow: 1_000_000 },
      } as ChatMessage]]));
      expect(service.contextWindowTokens()).toBe(1_000_000);
    });

    it('prefers the CLI-reported contextWindow on the last persisted message when no stream is active', () => {
      service['config'].set(makeConfig({ agentId: 'claude', agentModels: { claude: { model: 'claude-opus-4-7' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        { id: 'm1', role: 'assistant', usage: { inputTokens: 100, contextWindow: 1_000_000 } } as ChatMessage,
      ]]]));
      expect(service.contextWindowTokens()).toBe(1_000_000);
    });

    it('falls back to the static table when the stream has no contextWindow', () => {
      service['config'].set(makeConfig({ agentId: 'claude', agentModels: { claude: { model: 'claude-opus-4-7' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      service['assistantStreams'].set(new Map([['/tmp/p', {
        id: 'stream-1', role: 'assistant', text: '', tools: [], streaming: true,
        usage: { inputTokens: 1 },
      } as ChatMessage]]));
      expect(service.contextWindowTokens()).toBe(200_000);
    });
  });

  // ── contextPct ────────────────────────────────────────────────────────────

  describe('contextPct', () => {
    it('returns null when contextUsageTokens is null', () => {
      service['config'].set(makeConfig());
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      expect(service.contextPct()).toBeNull();
    });

    it('returns null when contextWindowTokens is null (no config)', () => {
      service['config'].set(null);
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { inputTokens: 100 } }),
      ]]]));
      expect(service.contextPct()).toBeNull();
    });

    it('computes correct ratio for normal usage', () => {
      service['config'].set(makeConfig({ agentId: 'claude', agentModels: { claude: { model: 'claude-opus-4-7' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { inputTokens: 100_000 } }),
      ]]]));
      // 100_000 / 200_000 = 0.5
      expect(service.contextPct()).toBe(0.5);
    });

    it('is capped at 1.0 when usage exceeds context window', () => {
      service['config'].set(makeConfig({ agentId: 'claude', agentModels: { claude: { model: 'claude-opus-4-7' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { inputTokens: 250_000 } }),
      ]]]));
      expect(service.contextPct()).toBe(1.0);
    });

    it('rounds to 4 decimal places', () => {
      service['config'].set(makeConfig({ agentId: 'claude', agentModels: { claude: { model: 'claude-opus-4-7' } } }));
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { inputTokens: 1 } }),
      ]]]));
      // 1 / 200_000 = 0.000005 → rounds to 0
      const pct = service.contextPct();
      expect(pct).not.toBeNull();
      // Verify rounding: value has at most 4 decimal places
      const decimalPart = pct!.toString().split('.')[1] ?? '';
      expect(decimalPart.length).toBeLessThanOrEqual(4);
    });
  });

  // ── sessionCostUsd ────────────────────────────────────────────────────────

  describe('sessionCostUsd', () => {
    it('returns null when no project selected', () => {
      service['selectedProject'].set(null);
      expect(service.sessionCostUsd()).toBeNull();
    });

    it('returns null when no assistant message has costUsd', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { inputTokens: 100 } }),
      ]]]));
      expect(service.sessionCostUsd()).toBeNull();
    });

    it('sums costUsd across assistant messages', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { costUsd: 0.001 } }),
        makeAssistantMsg({ usage: { costUsd: 0.002 } }),
      ]]]));
      expect(service.sessionCostUsd()).toBe(0.003);
    });

    it('includes active stream costUsd in the sum', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { costUsd: 0.001 } }),
      ]]]));
      service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({
        streaming: true,
        usage: { costUsd: 0.003 },
      })]]));
      expect(service.sessionCostUsd()).toBe(0.004);
    });

    it('returns null when only the stream is present but has no costUsd', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({
        streaming: true,
        usage: { inputTokens: 100 },
      })]]));
      expect(service.sessionCostUsd()).toBeNull();
    });

    it('is non-null with only stream costUsd (no historical messages)', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', []]]));
      service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({
        streaming: true,
        usage: { costUsd: 0.005 },
      })]]));
      expect(service.sessionCostUsd()).toBe(0.005);
    });

    it('rounds to 4 decimal places to avoid floating-point noise', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { costUsd: 0.0001 } }),
        makeAssistantMsg({ usage: { costUsd: 0.0002 } }),
        makeAssistantMsg({ usage: { costUsd: 0.0003 } }),
      ]]]));
      const cost = service.sessionCostUsd();
      expect(cost).not.toBeNull();
      const decimalPart = cost!.toString().split('.')[1] ?? '';
      expect(decimalPart.length).toBeLessThanOrEqual(4);
    });

    it('skips messages with costUsd of 0 but still returns non-null when others have cost', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { costUsd: 0 } }),
        makeAssistantMsg({ usage: { costUsd: 0.002 } }),
      ]]]));
      expect(service.sessionCostUsd()).toBe(0.002);
    });
  });

  // ── sessionCostTurns (S-1 T-4) ────────────────────────────────────────────

  describe('sessionCostTurns', () => {
    it('returns an empty array when no project selected', () => {
      service['selectedProject'].set(null);
      expect(service.sessionCostTurns()).toEqual([]);
    });

    it('returns one entry per assistant turn that reported a cost, numbered from 1', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { costUsd: 0.001 } }),
        makeAssistantMsg({ usage: { costUsd: 0.002 } }),
      ]]]));
      expect(service.sessionCostTurns()).toEqual([
        { turn: 1, costUsd: 0.001 },
        { turn: 2, costUsd: 0.002 },
      ]);
    });

    it('skips turns with no cost or zero cost', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { inputTokens: 100 } }),
        makeAssistantMsg({ usage: { costUsd: 0 } }),
        makeAssistantMsg({ usage: { costUsd: 0.002 } }),
      ]]]));
      expect(service.sessionCostTurns()).toEqual([{ turn: 1, costUsd: 0.002 }]);
    });

    it('appends the in-flight stream as the trailing turn', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { costUsd: 0.001 } }),
      ]]]));
      service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({
        streaming: true,
        usage: { costUsd: 0.003 },
      })]]));
      expect(service.sessionCostTurns()).toEqual([
        { turn: 1, costUsd: 0.001 },
        { turn: 2, costUsd: 0.003 },
      ]);
    });

    it('sum of the breakdown matches sessionCostUsd', () => {
      service['selectedProject'].set('/tmp/p');
      service['chats'].set(new Map([['/tmp/p', [
        makeAssistantMsg({ usage: { costUsd: 0.001 } }),
        makeAssistantMsg({ usage: { costUsd: 0.002 } }),
      ]]]));
      const breakdownSum = service.sessionCostTurns().reduce((s, t) => s + t.costUsd, 0);
      expect(Math.round(breakdownSum * 10000) / 10000).toBe(service.sessionCostUsd());
    });
  });
});

// ── Per-session stats maintenance (S-7 T-81) ────────────────────────────────

describe('AppStateService — session stats maintenance (S-7 T-81)', () => {
  let service: AppStateService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();
    service = TestBed.inject(AppStateService);
  });

  it('persists a derived rollup on flushSave', async () => {
    const saveChat = vi.fn().mockResolvedValue(true);
    (mockApi as Record<string, unknown>)['saveChat'] = saveChat;
    service['selectedProject'].set('/tmp/p');
    service['chats'].set(new Map([['/tmp/p', [
      makeAssistantMsg({ model: 'claude-x', usage: { inputTokens: 500, costUsd: 0.1, contextWindow: 200_000 } }),
    ]]]));

    await service.flushSave('/tmp/p');

    expect(saveChat).toHaveBeenCalledOnce();
    const stats = saveChat.mock.calls[0]![2];
    expect(stats.costUsd).toBe(0.1);
    expect(stats.contextTokens).toBe(500);
    expect(stats.contextWindow).toBe(200_000);
    expect(service.sessionStats().get('/tmp/p')?.costUsd).toBe(0.1);
  });

  it('restores the stored rollup on switchSession', async () => {
    const stored = {
      agentId: 'claude', model: 'm', contextWindow: 200_000, contextTokens: 1_000,
      costUsd: 0.5, turnCount: 1, compactions: [], updatedAt: 1,
    };
    (mockApi as Record<string, unknown>)['switchSession'] = vi.fn().mockResolvedValue({ id: 's', messages: [], stats: stored });

    await service.switchSession('/tmp/p', '11111111-1111-1111-1111-111111111111');

    expect(service.sessionStats().get('/tmp/p')).toEqual(stored);
  });

  it('derives a rollup on switchSession when the session stored none', async () => {
    (mockApi as Record<string, unknown>)['switchSession'] = vi.fn().mockResolvedValue({
      id: 's',
      messages: [
        makeAssistantMsg({ model: 'claude-x', usage: { inputTokens: 100, costUsd: 0.2, contextWindow: 200_000 } }),
      ],
    });

    await service.switchSession('/tmp/p', '11111111-1111-1111-1111-111111111111');

    const stats = service.sessionStats().get('/tmp/p');
    expect(stats?.costUsd).toBe(0.2);
    expect(stats?.contextTokens).toBe(100);
  });

  it('drops the rollup on clearChat (session reset)', () => {
    service['sessionStats'].set(new Map([['/tmp/p', {
      agentId: 'claude', costUsd: 0.5, turnCount: 1, compactions: [], updatedAt: 1,
    }]]));
    service.clearChat('/tmp/p');
    expect(service.sessionStats().get('/tmp/p')).toBeUndefined();
  });

  it('resetSessionLocal wipes the thread, drops a marker and persists (E-DSK-14 /clean)', async () => {
    const saveChat = vi.fn().mockResolvedValue(true);
    (mockApi as Record<string, unknown>)['saveChat'] = saveChat;
    service['chats'].set(new Map([['/tmp/p', [
      makeAssistantMsg({ id: 'old-1' }),
      makeAssistantMsg({ id: 'old-2' }),
    ]]]));

    await service.resetSessionLocal('/tmp/p', '/tmp/p');

    const left = service.chats().get('/tmp/p') ?? [];
    expect(left).toHaveLength(1);
    expect(left[0]?.role).toBe('system');
    // The fresh (cleared + marker) transcript was persisted immediately.
    expect(saveChat).toHaveBeenCalledTimes(1);
    expect(saveChat.mock.calls[0]?.[0]).toBe('/tmp/p');
    expect((saveChat.mock.calls[0]?.[1] as unknown[])).toHaveLength(1);
  });

  it('resetSessionLocal drops the in-flight stream so the killed run cannot land in the fresh session (E-DSK-14)', async () => {
    (mockApi as Record<string, unknown>)['saveChat'] = vi.fn().mockResolvedValue(true);
    service['chats'].set(new Map([['/tmp/p', [makeAssistantMsg({ id: 'old-1' })]]]));
    service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({ id: 'stream-1', streaming: true })]]));

    await service.resetSessionLocal('/tmp/p', '/tmp/p');

    // The live stream is gone — a trailing process:end finds nothing to finalise.
    expect(service.assistantStreams().has('/tmp/p')).toBe(false);
    const left = service.chats().get('/tmp/p') ?? [];
    expect(left).toHaveLength(1);
    expect(left[0]?.role).toBe('system');
  });

  it('resetSessionLocal only touches the keyed pane, never a parallel split session (S-13)', async () => {
    (mockApi as Record<string, unknown>)['saveChat'] = vi.fn().mockResolvedValue(true);
    // Primary pane (SessionKey === base project) + an additional split pane keyed
    // by its worktree dir. A reset must isolate to the SessionKey it is given.
    const primary = [makeAssistantMsg({ id: 'primary-1' }), makeAssistantMsg({ id: 'primary-2' })];
    const pane = [makeAssistantMsg({ id: 'pane-1' }), makeAssistantMsg({ id: 'pane-2' })];
    service['chats'].set(new Map([['/tmp/p', primary], ['/tmp/p/.wt/s2', pane]]));

    // Base/primary reset (Telegram /clean + sidebar path): the additional pane is intact.
    await service.resetSessionLocal('/tmp/p', '/tmp/p');
    const afterBase = service.chats().get('/tmp/p') ?? [];
    expect(afterBase).toHaveLength(1);
    expect(afterBase[0]?.role).toBe('system');
    expect(service.chats().get('/tmp/p/.wt/s2')).toBe(pane);

    // Per-pane reset (additional pane): only that pane is wiped, primary untouched.
    await service.resetSessionLocal('/tmp/p/.wt/s2', '/tmp/p');
    const afterPane = service.chats().get('/tmp/p/.wt/s2') ?? [];
    expect(afterPane).toHaveLength(1);
    expect(afterPane[0]?.role).toBe('system');
    expect(service.chats().get('/tmp/p')).toBe(afterBase);
  });

  it('appends a compaction record on a context_compacted event (T-83)', () => {
    (mockApi as Record<string, unknown>)['saveChat'] = vi.fn().mockResolvedValue(true);
    service['selectedProject'].set('/tmp/p');
    // An in-flight stream is required for consumeAgentEvent to act.
    service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({ id: 'stream-1', streaming: true })]]));
    service['chats'].set(new Map([['/tmp/p', []]]));

    service['consumeAgentEvent']({
      project: '/tmp/p',
      line: JSON.stringify({ type: 'context_compacted', trigger: 'auto', preTokens: 180_000 }),
    } as never);

    const comps = service.sessionStats().get('/tmp/p')?.compactions ?? [];
    expect(comps).toHaveLength(1);
    expect(comps[0]).toMatchObject({ trigger: 'auto', preTokens: 180_000 });
    expect(service.compactionCount()).toBe(1);
  });

  it('dedupes repeated tool_use events by id in the active stream', () => {
    service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({
      id: 'stream-1',
      streaming: true,
      toolCalls: [],
      contentBlocks: [],
    })]]));

    const event = { type: 'tool_use', id: 'tool-ask-1', name: 'AskUserQuestion', input: { question: 'Pick one' } };
    service['consumeAgentEvent']({ project: '/tmp/p', line: JSON.stringify(event) } as never);
    service['consumeAgentEvent']({ project: '/tmp/p', line: JSON.stringify(event) } as never);

    const stream = service['assistantStreams']().get('/tmp/p');
    expect(stream?.toolCalls).toHaveLength(1);
    expect(stream?.contentBlocks).toEqual([{ kind: 'tool_ref', toolCallId: 'tool-ask-1' }]);
    expect(stream?.events?.filter((entry) => entry.kind === 'tool_use')).toHaveLength(1);
  });
});

// ── Footer reads the active-session snapshot at rest (S-7 T-82) ──────────────

describe('AppStateService — footer reads session snapshot (S-7 T-82)', () => {
  let service: AppStateService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();
    service = TestBed.inject(AppStateService);
    service['selectedProject'].set('/tmp/p');
  });

  function setSnapshot(p: string, stats: Partial<{ model: string; contextWindow: number; contextTokens: number; costUsd: number }>) {
    service['sessionStats'].set(new Map([[p, {
      agentId: 'claude', costUsd: 0, turnCount: 1, compactions: [], updatedAt: 1, ...stats,
    }]]));
  }

  it('reads context tokens / window / model / cost from the snapshot at rest', () => {
    setSnapshot('/tmp/p', { model: 'claude-opus-4-8', contextWindow: 1_000_000, contextTokens: 250_000, costUsd: 0.73 });
    expect(service.activeModel()).toBe('claude-opus-4-8');
    expect(service.contextUsageTokens()).toBe(250_000);
    expect(service.contextWindowTokens()).toBe(1_000_000);
    expect(service.contextPct()).toBe(0.25);
    expect(service.sessionCostUsd()).toBe(0.73);
  });

  it('changes per session: swapping the snapshot moves the bar/cost', () => {
    setSnapshot('/tmp/p', { contextWindow: 200_000, contextTokens: 100_000, costUsd: 0.10 });
    expect(service.contextPct()).toBe(0.5);
    expect(service.sessionCostUsd()).toBe(0.10);
    // Simulate switching to another session of the same project.
    setSnapshot('/tmp/p', { contextWindow: 200_000, contextTokens: 20_000, costUsd: 0.02 });
    expect(service.contextPct()).toBe(0.1);
    expect(service.sessionCostUsd()).toBe(0.02);
  });

  it('the live stream still wins over the snapshot while a run is in flight', () => {
    setSnapshot('/tmp/p', { contextWindow: 200_000, contextTokens: 20_000, costUsd: 0.02 });
    service['assistantStreams'].set(new Map([['/tmp/p', makeAssistantMsg({
      streaming: true,
      usage: { inputTokens: 150_000, contextWindow: 200_000, costUsd: 0.05 },
    })]]));
    expect(service.contextUsageTokens()).toBe(150_000);
    // committed (none) + in-flight stream cost
    expect(service.sessionCostUsd()).toBe(0.05);
  });

  it('returns null cost when the snapshot has no cost (non-Claude session)', () => {
    setSnapshot('/tmp/p', { model: 'gemini-2.5-pro', contextWindow: 1_048_576, costUsd: 0 });
    expect(service.sessionCostUsd()).toBeNull();
    expect(service.activeModel()).toBe('gemini-2.5-pro');
  });
});

// ── Split-pane persistence redirect (S-13 T-156) ─────────────────────────────

describe('AppStateService — split-pane persistence redirect (S-13 T-156)', () => {
  let service: AppStateService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();
    service = TestBed.inject(AppStateService);
  });

  const BASE = '/workspace/proj';
  const RUN_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('an unregistered (primary/single) session saves under its own key', async () => {
    const saveChat = vi.fn().mockResolvedValue(true);
    const saveChatAs = vi.fn().mockResolvedValue(true);
    (mockApi as Record<string, unknown>)['saveChat'] = saveChat;
    (mockApi as Record<string, unknown>)['saveChatAs'] = saveChatAs;
    service['chats'].set(new Map([[BASE, []]]));

    await service.flushSave(BASE);

    expect(saveChat).toHaveBeenCalledOnce();
    expect(saveChat.mock.calls[0]![0]).toBe(BASE);
    expect(saveChatAs).not.toHaveBeenCalled();
  });

  it('a registered additional pane saves under its base project with its session id', async () => {
    const saveChat = vi.fn().mockResolvedValue(true);
    const saveChatAs = vi.fn().mockResolvedValue(true);
    (mockApi as Record<string, unknown>)['saveChat'] = saveChat;
    (mockApi as Record<string, unknown>)['saveChatAs'] = saveChatAs;
    service.registerSessionPersistence(RUN_KEY, BASE, RUN_KEY);
    service['chats'].set(new Map([[RUN_KEY, [makeAssistantMsg({ text: 'hi' })]]]));

    await service.flushSave(RUN_KEY);

    expect(saveChatAs).toHaveBeenCalledOnce();
    expect(saveChatAs.mock.calls[0]![0]).toBe(BASE);
    expect(saveChatAs.mock.calls[0]![1]).toBe(RUN_KEY);
    expect(saveChat).not.toHaveBeenCalled();
  });

  it('unregistering reverts the pane to the default save path', async () => {
    const saveChat = vi.fn().mockResolvedValue(true);
    const saveChatAs = vi.fn().mockResolvedValue(true);
    (mockApi as Record<string, unknown>)['saveChat'] = saveChat;
    (mockApi as Record<string, unknown>)['saveChatAs'] = saveChatAs;
    service.registerSessionPersistence(RUN_KEY, BASE, RUN_KEY);
    service.unregisterSessionPersistence(RUN_KEY);
    service['chats'].set(new Map([[RUN_KEY, []]]));

    await service.flushSave(RUN_KEY);

    expect(saveChat).toHaveBeenCalledOnce();
    expect(saveChatAs).not.toHaveBeenCalled();
  });

  describe('run mode persistence', () => {
    it('saves carry the current run mode (primary and split pane)', async () => {
      const saveChat = vi.fn().mockResolvedValue(true);
      const saveChatAs = vi.fn().mockResolvedValue(true);
      (mockApi as Record<string, unknown>)['saveChat'] = saveChat;
      (mockApi as Record<string, unknown>)['saveChatAs'] = saveChatAs;
      service.registerSessionPersistence(RUN_KEY, BASE, RUN_KEY);
      service['chats'].set(new Map([[BASE, []], [RUN_KEY, []]]));
      service.setRunMode(BASE, 'apply');
      service.setRunMode(RUN_KEY, 'apply-yolo');

      await service.flushSave(BASE);
      await service.flushSave(RUN_KEY);

      expect(saveChat.mock.calls[0]![3]).toBe('apply');
      expect(saveChatAs.mock.calls[0]![6]).toBe('apply-yolo');
    });

    it('changing the mode saves only when the chat has messages', () => {
      vi.useFakeTimers();
      try {
        const saveChat = vi.fn().mockResolvedValue(true);
        (mockApi as Record<string, unknown>)['saveChat'] = saveChat;
        service['chats'].set(new Map([[BASE, []], ['/other', [makeAssistantMsg({ text: 'hi' })]]]));

        service.setRunMode(BASE, 'apply');
        service.setRunMode('/other', 'apply');
        vi.advanceTimersByTime(1000);

        expect(saveChat).toHaveBeenCalledOnce();
        expect(saveChat.mock.calls[0]![0]).toBe('/other');
      } finally {
        vi.useRealTimers();
      }
    });

    it('loading a session restores its mode without saving; no mode means plan', () => {
      vi.useFakeTimers();
      try {
        const saveChat = vi.fn().mockResolvedValue(true);
        (mockApi as Record<string, unknown>)['saveChat'] = saveChat;

        service.loadSessionIntoKey(BASE, [makeAssistantMsg({ text: 'a' })], undefined, 'apply-yolo');
        expect(service.runMode(BASE)).toBe('apply-yolo');

        service.loadSessionIntoKey(BASE, [makeAssistantMsg({ text: 'b' })]);
        expect(service.runMode(BASE)).toBe('plan');

        vi.advanceTimersByTime(1000);
        expect(saveChat).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ── Focused-session drives the footer + sessions navbar (S-13 T-155/T-157) ────

describe('AppStateService — focused session drives shell (S-13 T-155/T-157)', () => {
  let service: AppStateService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();
    service = TestBed.inject(AppStateService);
  });

  const BASE = '/tmp/proj';
  const PANE = 'cccccccc-dddd-eeee-ffff-000000000000';

  it('footer falls back to the selected project when no pane is focused', () => {
    service['selectedProject'].set(BASE);
    service['sessionStats'].set(new Map([[BASE, {
      agentId: 'claude', model: 'm-base', contextWindow: 200_000, contextTokens: 10,
      costUsd: 0.4, turnCount: 1, compactions: [], updatedAt: 1,
    }]]));
    expect(service.focusedKey()).toBe(BASE);
    expect(service.activeModel()).toBe('m-base');
    expect(service.sessionCostUsd()).toBe(0.4);
  });

  it('footer reads the FOCUSED pane session, not the selected project', () => {
    service['selectedProject'].set(BASE);
    service['sessionStats'].set(new Map([
      [BASE, { agentId: 'claude', model: 'm-base', costUsd: 0.4, contextWindow: 200_000, contextTokens: 10, turnCount: 1, compactions: [], updatedAt: 1 }],
      [PANE, { agentId: 'claude', model: 'm-pane', costUsd: 0.9, contextWindow: 200_000, contextTokens: 99, turnCount: 1, compactions: [], updatedAt: 1 }],
    ]));

    service.setFocusedSession(PANE);

    expect(service.focusedKey()).toBe(PANE);
    expect(service.activeModel()).toBe('m-pane');
    expect(service.sessionCostUsd()).toBe(0.9);
    expect(service.contextUsageTokens()).toBe(99);
  });

  it('isSessionFocused: a focused pane marks its own session active, ignoring server isActive', () => {
    service.setFocusedSession(PANE);
    expect(service.isSessionFocused({ id: PANE, isActive: false } as never)).toBe(true);
    expect(service.isSessionFocused({ id: 'other', isActive: true } as never)).toBe(false);
  });

  it('isSessionFocused: with no pane focused, defers to the server isActive flag', () => {
    service.setFocusedSession(null);
    expect(service.isSessionFocused({ id: 'x', isActive: true } as never)).toBe(true);
    expect(service.isSessionFocused({ id: 'x', isActive: false } as never)).toBe(false);
  });

  it('tracks mounted pane sessions for sidebar click-routing', () => {
    expect(service.isSessionMounted(PANE)).toBe(false);
    service.setMountedPaneSessions(new Set([PANE]));
    expect(service.isSessionMounted(PANE)).toBe(true);
    expect(service.isSessionMounted('nope')).toBe(false);
  });

  it('requestPaneFocus / clearPaneFocusRequest toggle the bridge signal', () => {
    expect(service.paneFocusRequest()).toBeNull();
    service.requestPaneFocus(PANE);
    expect(service.paneFocusRequest()).toBe(PANE);
    service.clearPaneFocusRequest();
    expect(service.paneFocusRequest()).toBeNull();
  });
});

// ── onProcessEnd stamps errorClassification on the system error message ──────
// Regression: the error bubble's Retry/Continue actions key off
// msg.errorClassification, but onProcessEnd never copied e.classification, so
// every CLI failure rendered as a bare pill with no actions.

describe('AppStateService — onProcessEnd error message classification', () => {
  let service: AppStateService;
  let fireProcessEnd: ((e: ProcessEndEvent) => void) | null = null;

  const PROJECT = '/ws/project-err';

  beforeEach(async () => {
    fireProcessEnd = null;
    (mockApi as Record<string, unknown>)['onProcessEnd'] =
      (cb: (e: ProcessEndEvent) => void) => { fireProcessEnd = cb; };

    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();
    service = TestBed.inject(AppStateService);
    service['wireBridgeEvents']();
  });

  function lastSystemMessage(): ChatMessage | undefined {
    return service.chats().get(PROJECT)?.at(-1);
  }

  it('copies the event classification onto the system error message', () => {
    fireProcessEnd!({ project: PROJECT, code: 1, error: 'claude salió con código 1', classification: 'transient' });
    const msg = lastSystemMessage();
    expect(msg?.role).toBe('system');
    expect(msg?.errorClassification).toBe('transient');
  });

  it('falls back to "unknown" when the event carries no classification', () => {
    fireProcessEnd!({ project: PROJECT, code: 1, error: 'claude salió con código 1' });
    expect(lastSystemMessage()?.errorClassification).toBe('unknown');
  });

  it('does NOT classify user cancellations (plain pill, no actions)', () => {
    fireProcessEnd!({ project: PROJECT, code: null, error: 'killed', cancelReason: 'user' });
    const msg = lastSystemMessage();
    expect(msg?.cancelReason).toBe('user');
    expect(msg?.errorClassification).toBeUndefined();
  });

  it('does NOT classify idle cancellations either — cancelReason drives that UI', () => {
    fireProcessEnd!({ project: PROJECT, code: null, error: 'killed', cancelReason: 'idle' });
    const msg = lastSystemMessage();
    expect(msg?.cancelReason).toBe('idle');
    expect(msg?.errorClassification).toBeUndefined();
  });

  it('adds no system message for stopped/busy ends', () => {
    fireProcessEnd!({ project: PROJECT, code: null, error: 'stopped' });
    fireProcessEnd!({ project: PROJECT, code: null, error: 'busy' });
    expect(service.chats().get(PROJECT) ?? []).toHaveLength(0);
  });
});

describe('transcriptQuestionId', () => {
  const ASK = 'mcp__devia-ui__devia_ask_user';
  const stream = (toolCalls: NonNullable<ChatMessage['toolCalls']>): ChatMessage =>
    ({ id: 's', role: 'assistant', text: '', toolCalls }) as ChatMessage;

  it('re-keys a devia-ui callId onto the unanswered question tool call of the stream', () => {
    const s = stream([
      { id: 'toolu_old', name: ASK, result: 'A' },
      { id: 'toolu_read', name: 'Read' },
      { id: 'toolu_ask', name: ASK },
    ]);
    expect(transcriptQuestionId(s, 'ui-1234')).toBe('toolu_ask');
  });

  it('keeps an id that already names a tool call (AskUserQuestion path)', () => {
    const s = stream([{ id: 'toolu_q', name: 'AskUserQuestion' }]);
    expect(transcriptQuestionId(s, 'toolu_q')).toBe('toolu_q');
  });

  it('falls back to the callId when no question tool call is waiting', () => {
    const s = stream([{ id: 'toolu_ask', name: ASK, result: 'A' }]);
    expect(transcriptQuestionId(s, 'ui-1234')).toBe('ui-1234');
  });
});
