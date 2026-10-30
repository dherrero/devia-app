/**
 * S-25 F2.3 — `devia_request_review` routing.
 *
 * The Cambios view IS the card for this tool, so the panel is what takes the
 * user there and hands the comments back to the agent blocked on the call.
 * The diff rendering itself is covered by `diff-viewer.component.spec.ts`.
 */
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { DialogService } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UiToolRequestEvent } from '../../../../../shared/contracts/events';
import { AppStateService } from '../../../core/services/app-state.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { ChatPanelComponent } from './chat-panel.component';
import { PendingAttachmentsService } from './services/pending-attachments.service';
import { ChatScrollService } from './services/chat-scroll.service';

// jsdom has no IntersectionObserver; the feed only needs the calls to exist.
class MockIntersectionObserver {
  observe(): void {
    /* no-op */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}

const sendUiToolResult = vi.fn();
let emitUiTool: (e: UiToolRequestEvent) => void = () => undefined;

function createMockState() {
  const selectedProject = signal<string | null>('/ws/proj-a');
  return {
    _selectedProject: selectedProject,
    selectedProject,
    chats: signal(new Map<string, unknown[]>()),
    assistantStreams: signal(new Map()),
    pendingQuestions: signal(new Map()),
    queue: signal(new Map()),
    gitInfo: signal(null),
    runningPaths: signal(new Set<string>()),
    autoResumes: signal(new Map<string, number>()),
    focusedDiffFile: signal(null),
    splitActive: signal(false),
    reviewComments: signal(new Map()),
    isRunning: () => false,
    runMode: () => 'apply' as const,
    setRunMode: vi.fn(),
    messagesFor: () => [],
    streamFor: () => null,
    pendingQuestionFor: () => null,
    queueFor: () => ({ items: [], paused: false }),
    isUnisolatedAcknowledged: () => true,
    acknowledgeUnisolated: vi.fn(),
    storeLastPrompt: vi.fn(),
    addMessage: vi.fn(),
    lastPromptFor: () => '',
    composerInjection: () => null,
    clearComposerInjection: vi.fn(),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    registerSessionPersistence: vi.fn(),
    unregisterSessionPersistence: vi.fn(),
    resetSessionLocal: vi.fn().mockResolvedValue(undefined),
    retryLastPrompt: vi.fn(),
    // The view switches to Cambios, so the real diff viewer mounts.
    reconcileReviewComments: () => 0,
    getReviewComments: () => [],
    reviewCommentCount: () => 0,
    clearReviewComments: vi.fn(),
    setComposerDraft: vi.fn(),
  };
}

function createMockAttachments() {
  const items = signal<unknown[]>([]);
  return {
    items: items.asReadonly(),
    get hasAny() {
      return items().length > 0;
    },
    drain: vi.fn(() => []),
    restore: vi.fn(),
    disposePreviews: vi.fn(),
  };
}

const mockApi = {
  platform: 'linux' as const,
  isWSL: false,
  sendInstruction: vi.fn().mockResolvedValue(undefined),
  stopProject: vi.fn(),
  resetSession: vi.fn().mockResolvedValue(undefined),
  saveChat: vi.fn().mockResolvedValue(undefined),
  listSessions: vi.fn().mockResolvedValue([]),
  listQueue: vi.fn().mockResolvedValue({ items: [], paused: false }),
  setConfig: vi.fn().mockResolvedValue({}),
  getGitDiff: vi.fn().mockResolvedValue({ hasChanges: false, files: [] }),
  onUiToolRequest: (cb: (e: UiToolRequestEvent) => void) => {
    emitUiTool = cb;
  },
  sendUiToolResult,
};

describe('ChatPanelComponent — request_review routing (S-25 F2.3)', () => {
  let fixture: ComponentFixture<ChatPanelComponent>;
  let comp: ChatPanelComponent;

  beforeEach(async () => {
    (globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] =
      MockIntersectionObserver;
    sendUiToolResult.mockClear();
    emitUiTool = () => undefined;

    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: createMockState() },
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: DialogService, useValue: { confirm: vi.fn(() => of(true)) } },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    })
      .overrideComponent(ChatPanelComponent, {
        set: {
          providers: [
            { provide: PendingAttachmentsService, useValue: createMockAttachments() },
            ChatScrollService,
          ],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(ChatPanelComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });

  function requestReview(over: Partial<UiToolRequestEvent> = {}): void {
    emitUiTool({
      project: '/ws/proj-a',
      callId: 'r1',
      tool: 'request_review',
      input: {},
      expectsAnswer: true,
      ...over,
    });
    fixture.detectChanges();
  }

  it('takes the user to the Cambios view when the agent asks for a review', () => {
    expect(comp.view()).toBe('chat');
    requestReview();

    expect(comp.view()).toBe('changes');
    expect(comp.pendingReview()?.callId).toBe('r1');
  });

  it('ignores a review aimed at another pane', () => {
    requestReview({ project: '/ws/other' });

    expect(comp.pendingReview()).toBeNull();
    expect(comp.view()).toBe('chat');
  });

  it('exposes the paths the tool asked to narrow to', () => {
    requestReview({ input: { paths: ['a.ts', 'b.ts'] } });

    expect(comp.pendingReviewPaths()).toEqual(['a.ts', 'b.ts']);
  });

  it('defaults to no narrowing when the tool sent no paths', () => {
    requestReview({ input: { intro: 'mira esto' } });

    expect(comp.pendingReviewPaths()).toEqual([]);
  });

  it('hands the built comments back to the blocked agent', () => {
    requestReview();
    comp.onReviewResolved('revisa: cambia X en a.ts:12');

    expect(sendUiToolResult).toHaveBeenCalledOnce();
    const [, callId, answer] = sendUiToolResult.mock.calls[0] as [string, string, string];
    expect(callId).toBe('r1');
    expect(answer).toContain('revisa: cambia X en a.ts:12');
  });

  it('resolves a cancelled review as neutral, never as an error', () => {
    requestReview();
    comp.onReviewResolved(null);

    const [, , answer] = sendUiToolResult.mock.calls[0] as [string, string, string];
    expect(answer).toContain('without leaving comments');
    expect(answer).not.toContain('Error');
  });

  it('does nothing when there is no live review to resolve', () => {
    comp.onReviewResolved('algo');

    expect(sendUiToolResult).not.toHaveBeenCalled();
  });

  it('drops the request once resolved, so the panel leaves tool mode', () => {
    requestReview();
    comp.onReviewResolved(null);
    fixture.detectChanges();

    expect(comp.pendingReview()).toBeNull();
  });
});
