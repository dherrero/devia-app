/**
 * S-13 T-146 — Live-state isolation by sessionKey.
 *
 * Proves that two sessions of the same base project (distinct session keys)
 * never share chats, stream, stats, running flag or pendingQuestion in memory,
 * and that the single-session (single key) case is unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { AppStateService } from './app-state.service';
import { ElectronApiService } from './electron-api.service';
import { ToastService } from './toast.service';
import type { ChatMessage } from '../../../../shared/domain/chat';

const noop = (): void => undefined;

const mockApi: Partial<ElectronApiService> = {
  platform: 'linux',
  isWSL: false,
  onClaudeOutput: noop as never,
  onProcessStart: noop as never,
  onProcessEnd: noop as never,
  onComposeStart: noop as never,
  onComposeOutput: noop as never,
  onComposeEnd: noop as never,
  onOutboxFile: noop as never,
  onCloneStart: noop as never,
  onCloneOutput: noop as never,
  onCloneEnd: noop as never,
  onGitInfoChanged: noop as never,
  onConfigChanged: noop as never,
  onNotificationClick: noop as never,
  onAgentChanged: noop as never,
  onQueueChanged: noop as never,
  onQueueDispatched: noop as never,
  onTerminalData: noop as never,
  onTerminalExit: noop as never,
  onQuestionAsk: noop as never,
  onDiffSnapshot: noop as never,
  onAgentsDetected: noop as never,
  onSkillRegistryChanged: noop as never,
  onMcpListChanged: noop as never,
  onSubAgentsChanged: noop as never,
  onKanbanChanged: noop as never,
  onAgentWake: noop as never,
  onSddNotification: noop as never,
  onRemoteControlStatus: noop as never,
  onRemoteSelectProject: noop as never,
};

const mockToast: Partial<ToastService> = { show: noop as never };

function msg(text: string): ChatMessage {
  return { id: `m-${text}`, role: 'assistant', text } as ChatMessage;
}

// Two sessions of the SAME base project: primary uses the project path,
// the additional session uses its worktree dir (T-145 worktreeDir-as-identity).
const K_PRIMARY = '/ws/proj';
const K_EXTRA = '/home/u/.devia-app/worktrees/-ws-proj/sess-2';

describe('AppStateService — live-state isolation by sessionKey (T-146)', () => {
  let s: AppStateService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();
    s = TestBed.inject(AppStateService);
  });

  it('chats: a message under one key is invisible under the other', () => {
    s.addMessage(K_PRIMARY, msg('hello'));
    expect(s.chats().get(K_PRIMARY)?.map((m) => m.text)).toEqual(['hello']);
    expect(s.chats().get(K_EXTRA)).toBeUndefined();
  });

  it('runningPaths: isRunning is per session key', () => {
    s.runningPaths.set(new Set([K_PRIMARY]));
    expect(s.isRunning(K_PRIMARY)).toBe(true);
    expect(s.isRunning(K_EXTRA)).toBe(false);
  });

  it('assistantStreams: a live stream under one key is not seen under the other', () => {
    s.assistantStreams.set(new Map([[K_PRIMARY, msg('streaming')]]));
    expect(s.assistantStreams().get(K_PRIMARY)?.text).toBe('streaming');
    expect(s.assistantStreams().get(K_EXTRA)).toBeUndefined();
  });

  it('pendingQuestions: a pending question under one key is not seen under the other', () => {
    const q = { project: K_EXTRA, toolUseId: 't1', question: 'pick one' } as never;
    s.pendingQuestions.set(new Map([[K_EXTRA, q]]));
    expect(s.pendingQuestions().get(K_EXTRA)).toBeDefined();
    expect(s.pendingQuestions().get(K_PRIMARY)).toBeUndefined();
  });

  it('clearChat on one key leaves the other untouched', () => {
    s.addMessage(K_PRIMARY, msg('a'));
    s.addMessage(K_EXTRA, msg('b'));
    s.clearChat(K_EXTRA);
    expect(s.chats().get(K_PRIMARY)?.length).toBe(1);
    expect(s.chats().get(K_EXTRA) ?? []).toEqual([]);
  });

  it('single-session (one key): adding messages accumulates as before (zero regression)', () => {
    s.addMessage(K_PRIMARY, msg('1'));
    s.addMessage(K_PRIMARY, msg('2'));
    expect(s.chats().get(K_PRIMARY)?.map((m) => m.text)).toEqual(['1', '2']);
    expect(s.chats().size).toBe(1);
  });

  it('runMode: defaults to apply and is independent per session key (T-148)', () => {
    expect(s.runMode(K_PRIMARY)).toBe('apply');
    s.setRunMode(K_PRIMARY, 'plan');
    expect(s.runMode(K_PRIMARY)).toBe('plan');
    expect(s.runMode(K_EXTRA)).toBe('apply');
  });

  it('composerInjection: draft targets only its session key, clear is scoped (T-148)', () => {
    s.setComposerDraft(K_PRIMARY, 'revisa: foo');
    expect(s.composerInjection(K_PRIMARY)).toBe('revisa: foo');
    expect(s.composerInjection(K_EXTRA)).toBeNull();
    s.clearComposerInjection(K_PRIMARY);
    expect(s.composerInjection(K_PRIMARY)).toBeNull();
  });
});
