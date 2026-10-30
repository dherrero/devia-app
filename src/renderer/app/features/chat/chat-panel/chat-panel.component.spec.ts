/**
 * S-4 T-75 — Tests for the bottom-anchored windowing logic in ChatPanelComponent.
 *
 * Strategy: test the pure signal/computed layer (firstVisibleIdx, windowedMessages,
 * prependChunk) without exercising the DOM or IntersectionObserver — same pattern
 * as message-bubble.component.spec.ts.  A minimal mock AppStateService exposes
 * writable signals that drive currentMessages / stickToBottom / selectedProject,
 * and we assert on firstVisibleIdx() / windowedMessages() directly.
 *
 * IntersectionObserver is not available in jsdom; we install a global stub that
 * captures the callback so any test that needs the sentinel path can invoke it
 * manually.  The stub is reset between tests via beforeEach.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal, NO_ERRORS_SCHEMA } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ChatPanelComponent } from './chat-panel.component';
import { ComposerDraftStore } from '../composer/composer-draft.store';
import { AppStateService } from '../../../core/services/app-state.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { PendingAttachmentsService } from './services/pending-attachments.service';
import type { PendingAttachment } from './models/pending-attachment.model';
import { ChatScrollService } from './services/chat-scroll.service';
import { DialogService } from '@devia/ui';
import { of } from 'rxjs';
import type { ChatMessage } from '../../../../../shared/domain/chat';

// ── IntersectionObserver stub ─────────────────────────────────────────────────
// jsdom does not implement IntersectionObserver. The component's sentinel effect
// guards with `typeof IntersectionObserver === 'undefined'` so the observer is
// never attached in the test environment — which is exactly what we want for
// pure-signal tests. The stub below is available for tests that need to exercise
// the prependChunk path by invoking the captured callback manually.

type IOCallback = (entries: IntersectionObserverEntry[]) => void;
let capturedIOCallback: IOCallback | null = null;

class MockIntersectionObserver {
  constructor(cb: IOCallback) {
    capturedIOCallback = cb;
  }
  observe()    { /* no-op */ }
  unobserve()  { /* no-op */ }
  disconnect() { /* no-op */ }
}

// ── Message factory ───────────────────────────────────────────────────────────

let msgCounter = 0;

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${++msgCounter}`,
    role: 'user',
    text: 'hello',
    ...overrides,
  } as ChatMessage;
}

function makeMsgs(count: number): ChatMessage[] {
  return Array.from({ length: count }, () => makeMsg());
}

// ── Minimal AppStateService mock ──────────────────────────────────────────────
// We expose writable signals directly so test cases can drive state without
// going through the full bootstrap cycle.

function createMockState() {
  const _selectedProject = signal<string | null>('/ws/project-a');
  const _chats = signal<Map<string, ChatMessage[]>>(new Map());
  const _assistantStreams = signal<Map<string, ChatMessage>>(new Map());
  const _pendingQuestions = signal<Map<string, unknown>>(new Map());
  const _gitInfo = signal<unknown | null>(null);
  const _focusedDiffFile = signal<string | null>(null);
  const _composerInjection = signal<string | null>(null);
  const _runMode = signal<'plan' | 'apply' | 'apply-yolo'>('apply');
  const _runningPaths = signal<ReadonlySet<string>>(new Set());

  return {
    // Public writables for test manipulation
    _selectedProject,
    _chats,

    // AppStateService surface consumed by ChatPanelComponent
    selectedProject: _selectedProject.asReadonly(),
    chats: _chats.asReadonly(),
    assistantStreams: _assistantStreams.asReadonly(),
    pendingQuestions: _pendingQuestions.asReadonly(),
    gitInfo: _gitInfo.asReadonly(),
    focusedDiffFile: _focusedDiffFile.asReadonly(),
    composerInjection: _composerInjection,
    clearComposerInjection: vi.fn(),
    _runMode,
    runMode: _runMode,
    setRunMode: vi.fn((_key: string, mode: 'plan' | 'apply' | 'apply-yolo') => _runMode.set(mode)),
    runningPaths: _runningPaths.asReadonly(),
    autoResumes: signal(new Map<string, number>()),

    isRunning: (_p: string) => false,
    addMessage: vi.fn(),
    answerQuestion: vi.fn(),
    storeLastPrompt: vi.fn(),
    retryLastPrompt: vi.fn().mockResolvedValue(true),
    clearChat: vi.fn(),
    flushSave: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    // S-3 F1.1 — unisolated-pane consent
    isUnisolatedAcknowledged: vi.fn(() => false),
    acknowledgeUnisolated: vi.fn(),

    // helper — set messages for the selected project
    setMessages(msgs: ChatMessage[]) {
      const p = _selectedProject() ?? '/ws/project-a';
      const next = new Map(_chats());
      next.set(p, msgs);
      _chats.set(next);
    },
  };
}

// ── Minimal ElectronApiService mock ──────────────────────────────────────────

// S-3 F1.1 — unisolated-pane confirm dialog
const dialogsMock = { confirm: vi.fn(() => of(true)) };

const mockApi: Partial<ElectronApiService> = {
  platform: 'linux' as const,
  isWSL: false,
  sendInstruction: vi.fn().mockResolvedValue(undefined),
  stopProject: vi.fn(),
  resetSession: vi.fn().mockResolvedValue(undefined),
  saveChat: vi.fn().mockResolvedValue(undefined),
  listSessions: vi.fn().mockResolvedValue([]),
  listQueue: vi.fn().mockResolvedValue({ items: [], paused: false }),
  setConfig: vi.fn().mockResolvedValue({}),
  // S-25: the panel mounts `ds-ui-tool-host`, which injects UiToolsService and
  // subscribes on construction.
  onUiToolRequest: vi.fn(),
  sendUiToolResult: vi.fn().mockResolvedValue(undefined),
};

function createMockAttachments() {
  const items = signal<PendingAttachment[]>([]);

  return {
    _items: items,
    items: items.asReadonly(),
    get hasAny() {
      return items().length > 0;
    },
    drain: vi.fn(() => {
      const snap = items();
      items.set([]);
      return snap;
    }),
    disposePreviews: vi.fn(),
    remove: vi.fn(),
    add: vi.fn(),
    restore: vi.fn((list: readonly PendingAttachment[]) => items.set([...list])),
  };
}

function makePendingAttachment(id: string): PendingAttachment {
  return {
    id,
    name: `${id}.png`,
    mime: 'image/png',
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    previewUrl: `blob://fake/${id}`,
    kind: 'image',
    size: 3,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ChatPanelComponent — windowing logic (S-4 T-75)', () => {
  let fixture: ComponentFixture<ChatPanelComponent>;
  let comp: ChatPanelComponent;
  let mockState: ReturnType<typeof createMockState>;

  beforeEach(async () => {
    // Reset per-test state
    msgCounter = 0;
    capturedIOCallback = null;

    // Install the IO stub so the component's effect doesn't crash even if
    // the environment resolves IntersectionObserver.
    (globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] =
      MockIntersectionObserver;

    mockState = createMockState();

    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService,    useValue: mockState },
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService,       useValue: { show: vi.fn() } },
        { provide: DialogService,      useValue: dialogsMock },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    })
    // PendingAttachmentsService is now component-scoped (providers[]).
    // Override the component providers so the mock is resolved from the
    // component injector rather than the module injector.
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

  // ── TC-1: tail-pinning with 100 messages ──────────────────────────────────
  it('TC-1: with 100 messages firstVisibleIdx===80 and windowedMessages has 20 entries', () => {
    const msgs = makeMsgs(100);
    mockState.setMessages(msgs);
    fixture.detectChanges();

    expect(comp.firstVisibleIdx()).toBe(80);
    expect(comp.windowedMessages().length).toBe(20);
    // The mounted slice is the tail
    expect(comp.windowedMessages()[0].id).toBe(msgs[80].id);
    expect(comp.windowedMessages()[19].id).toBe(msgs[99].id);
  });

  // ── TC-2: fewer messages than WINDOW_SIZE → all mounted ───────────────────
  it('TC-2: with 5 messages firstVisibleIdx===0 and all are mounted', () => {
    const msgs = makeMsgs(5);
    mockState.setMessages(msgs);
    fixture.detectChanges();

    expect(comp.firstVisibleIdx()).toBe(0);
    expect(comp.windowedMessages().length).toBe(5);
  });

  // ── TC-3: prependChunk decrements firstVisibleIdx by LOAD_CHUNK ───────────
  it('TC-3: prependChunk decrements firstVisibleIdx by LOAD_CHUNK, clamped to 0, and grows windowedMessages', () => {
    // Set up 40 messages so there is room to prepend (firstVisibleIdx starts at 20)
    const msgs = makeMsgs(40);
    mockState.setMessages(msgs);
    fixture.detectChanges();

    // Confirm initial state
    expect(comp.firstVisibleIdx()).toBe(20);
    expect(comp.windowedMessages().length).toBe(20);

    // Call prependChunk indirectly — it's private, but we can access it via
    // the public sentinel-intersection path if IntersectionObserver is available.
    // In jsdom the IO is stubbed at class level but the component's effect guards
    // with typeof check and only attaches when a real scroller element exists.
    // For pure-signal tests we call prependChunk via casting.
    (comp as unknown as { prependChunk(s: HTMLElement): void })
      .prependChunk(document.createElement('div'));
    fixture.detectChanges();

    expect(comp.firstVisibleIdx()).toBe(10);
    expect(comp.windowedMessages().length).toBe(30);
  });

  it('TC-3b: prependChunk is clamped to 0 when already near the start', () => {
    const msgs = makeMsgs(25);
    mockState.setMessages(msgs);
    fixture.detectChanges();

    // firstVisibleIdx starts at 5 (25 - 20)
    expect(comp.firstVisibleIdx()).toBe(5);

    // One prependChunk: max(0, 5 - 10) = 0
    (comp as unknown as { prependChunk(s: HTMLElement): void })
      .prependChunk(document.createElement('div'));
    fixture.detectChanges();

    expect(comp.firstVisibleIdx()).toBe(0);
    expect(comp.windowedMessages().length).toBe(25);
  });

  // ── TC-4: session change re-pins to the tail ──────────────────────────────
  it('TC-4: switching to a different project re-pins firstVisibleIdx to the tail', () => {
    // Start on project-a with 100 messages → firstVisibleIdx = 80
    const msgsA = makeMsgs(100);
    mockState.setMessages(msgsA);
    fixture.detectChanges();
    expect(comp.firstVisibleIdx()).toBe(80);

    // Simulate the user scrolling up (decrement window)
    (comp as unknown as { prependChunk(s: HTMLElement): void })
      .prependChunk(document.createElement('div'));
    fixture.detectChanges();
    expect(comp.firstVisibleIdx()).toBe(70);

    // Switch to a new project with 50 messages
    mockState._selectedProject.set('/ws/project-b');
    const msgsB = makeMsgs(50);
    const nextChats = new Map<string, ChatMessage[]>();
    nextChats.set('/ws/project-a', msgsA);
    nextChats.set('/ws/project-b', msgsB);
    mockState._chats.set(nextChats);
    fixture.detectChanges();

    // Must re-pin to tail of project-b (50 - 20 = 30)
    expect(comp.firstVisibleIdx()).toBe(30);
    expect(comp.windowedMessages().length).toBe(20);
  });

  it('TC-4b: session reset (same project, array replaced) re-pins to the tail', () => {
    // Load session A with 40 messages
    const sessionA = makeMsgs(40);
    mockState.setMessages(sessionA);
    fixture.detectChanges();
    expect(comp.firstVisibleIdx()).toBe(20);

    // User scrolls up
    (comp as unknown as { prependChunk(s: HTMLElement): void })
      .prependChunk(document.createElement('div'));
    fixture.detectChanges();
    expect(comp.firstVisibleIdx()).toBe(10);

    // Simulate resetSession: clear to [] then insert a new system message
    // (different first-message id → session key changes → re-pin)
    const resetMsg = makeMsg({ role: 'system', text: 'Session reset.' });
    const p = mockState._selectedProject()!;
    const next = new Map(mockState._chats());
    next.set(p, [resetMsg]);
    mockState._chats.set(next);
    fixture.detectChanges();

    // 1 message < WINDOW_SIZE → firstVisibleIdx = 0, all mounted
    expect(comp.firstVisibleIdx()).toBe(0);
    expect(comp.windowedMessages().length).toBe(1);
  });

  // ── TC-5: regression — scrolled-up + new message → window unchanged ───────
  it('TC-5: when scrolled up (stickToBottom false) and a message is appended, firstVisibleIdx is preserved', () => {
    // Start with 40 messages, firstVisibleIdx = 20
    const msgs = makeMsgs(40);
    mockState.setMessages(msgs);
    fixture.detectChanges();
    expect(comp.firstVisibleIdx()).toBe(20);

    // User scrolls up → stickToBottom flips false
    comp.stickToBottom.set(false);

    // User scrolls up further → firstVisibleIdx = 10
    (comp as unknown as { prependChunk(s: HTMLElement): void })
      .prependChunk(document.createElement('div'));
    fixture.detectChanges();
    expect(comp.firstVisibleIdx()).toBe(10);
    // stickToBottom is still false (prependChunk doesn't change it)

    // New message arrives in the SAME session (append, same first-message id)
    const updatedMsgs = [...msgs, makeMsg({ role: 'assistant', text: 'New response' })];
    const p = mockState._selectedProject()!;
    const next = new Map(mockState._chats());
    next.set(p, updatedMsgs);
    mockState._chats.set(next);
    fixture.detectChanges();

    // MUST NOT re-pin — the window stays at 10 so history is preserved
    expect(comp.firstVisibleIdx()).toBe(10);
    // The mounted window is now messages[10..40] = 31 messages (grew by 1)
    expect(comp.windowedMessages().length).toBe(31);
  });

  // ── TC-6: stuck to bottom + new message → window tracks the tail ──────────
  it('TC-6: when stuck to bottom (stickToBottom true) and a message is appended, window tracks the tail', () => {
    // Start with 40 messages (stickToBottom defaults to true)
    const msgs = makeMsgs(40);
    mockState.setMessages(msgs);
    fixture.detectChanges();

    // firstVisibleIdx should be at the tail: 40 - 20 = 20
    expect(comp.firstVisibleIdx()).toBe(20);
    expect(comp.stickToBottom()).toBe(true);

    // Append a new message (same session, same first-message id)
    const newMsg = makeMsg({ role: 'assistant', text: 'Stream complete.' });
    const updatedMsgs = [...msgs, newMsg];
    const p = mockState._selectedProject()!;
    const next = new Map(mockState._chats());
    next.set(p, updatedMsgs);
    mockState._chats.set(next);
    fixture.detectChanges();

    // With stickToBottom=true the window re-pins to the new tail:
    // 41 - 20 = 21 → firstVisibleIdx = 21, newest message is mounted
    expect(comp.firstVisibleIdx()).toBe(21);
    expect(comp.windowedMessages().length).toBe(20);
    // The newest message must be the last in the mounted window
    expect(comp.windowedMessages()[19].id).toBe(newMsg.id);
  });
});

// ── S-13 T-149 — instanceable via the `project` input ───────────────────────

describe('ChatPanelComponent — instanceable via project input (S-13 T-149)', () => {
  let fixture: ComponentFixture<ChatPanelComponent>;
  let comp: ChatPanelComponent;
  let mockState: ReturnType<typeof createMockState>;

  beforeEach(async () => {
    (globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] =
      MockIntersectionObserver;
    mockState = createMockState();

    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: mockState },
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: DialogService, useValue: dialogsMock },
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
  });

  it('the bound project input drives the panel, not the global selectedProject', () => {
    // Global selection is project-a; the panel is explicitly bound to project-b.
    mockState._selectedProject.set('/ws/project-a');
    const next = new Map<string, ChatMessage[]>();
    next.set('/ws/project-b', [makeMsg()]);
    mockState._chats.set(next);

    fixture.componentRef.setInput('project', '/ws/project-b');
    fixture.detectChanges();

    expect(comp.effectiveProject()).toBe('/ws/project-b');
    expect(comp.sessionKey()).toBe('/ws/project-b');
    expect(comp.currentMessages().length).toBe(1);
  });

  it('falls back to the global selection when the input is unbound (single mount)', () => {
    mockState._selectedProject.set('/ws/project-a');
    fixture.detectChanges();
    expect(comp.effectiveProject()).toBe('/ws/project-a');
  });

  it('an additional pane (runKey set) keys its live state by runKey, not the base project', () => {
    mockState._selectedProject.set('/ws/project-a');
    const wt = '/wt/proj-a/s2';
    const next = new Map<string, ChatMessage[]>();
    next.set(wt, [makeMsg()]); // messages live under the worktree key
    next.set('/ws/project-a', []); // base project has none for this pane
    mockState._chats.set(next);

    fixture.componentRef.setInput('project', '/ws/project-a');
    fixture.componentRef.setInput('runKey', wt);
    fixture.componentRef.setInput('isolate', true);
    fixture.detectChanges();

    expect(comp.effectiveProject()).toBe('/ws/project-a'); // base = cwd/display
    expect(comp.sessionKey()).toBe(wt); // state key = runKey
    expect(comp.isolate()).toBe(true);
    expect(comp.currentMessages().length).toBe(1);
  });

  it('send() from an additional pane forwards { runKey, isolate } and runs against the base project', async () => {
    const sendSpy = mockApi.sendInstruction as ReturnType<typeof vi.fn>;
    sendSpy.mockClear();
    mockState._selectedProject.set('/ws/project-a');
    const wt = '/wt/proj-a/s2';
    fixture.componentRef.setInput('project', '/ws/project-a');
    fixture.componentRef.setInput('runKey', wt);
    fixture.componentRef.setInput('isolate', true);
    fixture.detectChanges();

    comp.draft.set('hola');
    await comp.send();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const args = sendSpy.mock.calls[0];
    expect(args[0]).toBe('/ws/project-a'); // base project = cwd source
    expect(args[5]).toEqual({ runKey: wt, isolate: true });
  });

  it('continueFromBubble() auto-sends the localized continue-after-error message', async () => {
    const sendSpy = mockApi.sendInstruction as ReturnType<typeof vi.fn>;
    sendSpy.mockClear();
    mockState._selectedProject.set('/ws/project-a');
    fixture.detectChanges();

    comp.continueFromBubble();

    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));
    // No translations are loaded in the test module, so instant() echoes the key.
    expect(sendSpy.mock.calls[0]?.[1]).toBe('message_bubble.continue_after_error_text');
  });

  // ── S-3 F1.1 — first send on an UNISOLATED additional pane asks for consent ──

  function mountUnisolatedPane(): void {
    mockState._selectedProject.set('/ws/project-a');
    fixture.componentRef.setInput('project', '/ws/project-a');
    fixture.componentRef.setInput('runKey', '/ws/project-a'); // workdir === base ⇒ no isolation
    fixture.componentRef.setInput('isolate', false);
    fixture.detectChanges();
  }

  it('S-3 F1.1: confirming the unisolated send proceeds and remembers the consent', async () => {
    const sendSpy = mockApi.sendInstruction as ReturnType<typeof vi.fn>;
    sendSpy.mockClear();
    dialogsMock.confirm.mockReturnValue(of(true));
    mountUnisolatedPane();

    comp.draft.set('hola');
    await comp.send();

    expect(dialogsMock.confirm).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(mockState.acknowledgeUnisolated).toHaveBeenCalledWith('/ws/project-a');
  });

  it('S-3 F1.1: cancelling keeps the draft and sends nothing', async () => {
    const sendSpy = mockApi.sendInstruction as ReturnType<typeof vi.fn>;
    sendSpy.mockClear();
    dialogsMock.confirm.mockReturnValue(of(false));
    mountUnisolatedPane();

    comp.draft.set('hola');
    await comp.send();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(comp.draft()).toBe('hola');
    expect(mockState.acknowledgeUnisolated).not.toHaveBeenCalled();
  });

  it('S-3 F1.1: an acknowledged pane (or an isolated one) never re-asks', async () => {
    const sendSpy = mockApi.sendInstruction as ReturnType<typeof vi.fn>;
    sendSpy.mockClear();
    dialogsMock.confirm.mockClear();
    (mockState.isUnisolatedAcknowledged as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mountUnisolatedPane();

    comp.draft.set('hola');
    await comp.send();

    expect(dialogsMock.confirm).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

// ── S-14 — composer draft survives route navigation ──────────────────────────

describe('ChatPanelComponent — composer draft persistence (S-14)', () => {
  let fixture: ComponentFixture<ChatPanelComponent>;
  let comp: ChatPanelComponent;
  let mockState: ReturnType<typeof createMockState>;
  let mockAtts: ReturnType<typeof createMockAttachments>;
  let store: ComposerDraftStore;

  beforeEach(async () => {
    (globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] =
      MockIntersectionObserver;
    mockState = createMockState();
    mockAtts = createMockAttachments();

    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: mockState },
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: DialogService, useValue: dialogsMock },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    })
      .overrideComponent(ChatPanelComponent, {
        set: {
          providers: [
            { provide: PendingAttachmentsService, useValue: mockAtts },
            ChatScrollService,
          ],
        },
      })
      .compileComponents();

    store = TestBed.inject(ComposerDraftStore);
  });

  function mount(): void {
    fixture = TestBed.createComponent(ChatPanelComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  }

  it('restores the stored draft for the sessionKey on creation', () => {
    store.save('/ws/project-a', { draft: 'texto sin enviar', attachments: [] });
    mount();
    expect(comp.draft()).toBe('texto sin enviar');
  });

  it('typing syncs the draft to the store', () => {
    mount();
    comp.draft.set('escribiendo…');
    fixture.detectChanges();
    expect(store.snapshot('/ws/project-a')?.draft).toBe('escribiendo…');
  });

  it('destroying the component captures the final draft (navigate away)', () => {
    mount();
    comp.draft.set('último estado');
    fixture.destroy();
    expect(store.snapshot('/ws/project-a')?.draft).toBe('último estado');
  });

  it('a remount after destroy restores what was typed — the full navigation round-trip', () => {
    mount();
    comp.draft.set('borrador vivo');
    fixture.destroy();

    mount();
    expect(comp.draft()).toBe('borrador vivo');
  });

  it('send() clears the draft AND its store entry', async () => {
    mount();
    comp.draft.set('mensaje enviado');
    fixture.detectChanges();
    expect(store.snapshot('/ws/project-a')).not.toBeNull();

    await comp.send();
    fixture.detectChanges();

    expect(comp.draft()).toBe('');
    expect(store.snapshot('/ws/project-a')).toBeNull();
  });

  it('a split pane keys its draft by runKey, isolated from the primary pane', () => {
    store.save('/ws/project-a', { draft: 'primary draft', attachments: [] });
    store.save('session-uuid-1', { draft: 'split draft', attachments: [] });

    fixture = TestBed.createComponent(ChatPanelComponent);
    comp = fixture.componentInstance;
    fixture.componentRef.setInput('project', '/ws/project-a');
    fixture.componentRef.setInput('runKey', 'session-uuid-1');
    fixture.componentRef.setInput('isolate', true);
    fixture.detectChanges();

    expect(comp.draft()).toBe('split draft');
    expect(store.snapshot('/ws/project-a')?.draft).toBe('primary draft');
  });

  it('switching the primary pane to another project swaps drafts per project', () => {
    mount();
    comp.draft.set('borrador de A');
    fixture.detectChanges();

    mockState._selectedProject.set('/ws/project-b');
    fixture.detectChanges();

    expect(comp.draft()).toBe('');
    expect(store.snapshot('/ws/project-a')?.draft).toBe('borrador de A');

    comp.draft.set('borrador de B');
    fixture.detectChanges();
    mockState._selectedProject.set('/ws/project-a');
    fixture.detectChanges();

    expect(comp.draft()).toBe('borrador de A');
    expect(store.snapshot('/ws/project-b')?.draft).toBe('borrador de B');
  });

  it('a composer injection wins over the restored draft', () => {
    store.save('/ws/project-a', { draft: 'restaurado', attachments: [] });
    mockState.composerInjection.set('inyectado');
    mount();

    expect(comp.draft()).toBe('inyectado');
    mockState.composerInjection.set(null);
  });

  // ── T-161: pending attachments ─────────────────────────────────────────

  it('restores stored attachments on creation', () => {
    const att = makePendingAttachment('one');
    store.save('/ws/project-a', { draft: 'con adjunto', attachments: [att] });
    mount();

    expect(mockAtts.restore).toHaveBeenCalledWith([att]);
    expect(mockAtts.items().length).toBe(1);
  });

  it('adding an attachment syncs it to the store, even with an empty draft', () => {
    mount();
    mockAtts._items.set([makePendingAttachment('one')]);
    fixture.detectChanges();

    expect(store.snapshot('/ws/project-a')?.attachments.length).toBe(1);
  });

  it('attachments survive the navigation round-trip (destroy + remount)', () => {
    mount();
    mockAtts._items.set([makePendingAttachment('one')]);
    fixture.destroy();

    // A real remount gets a FRESH component-scoped attachments service;
    // the shared mock simulates that by starting empty again.
    mockAtts._items.set([]);
    mockAtts.restore.mockClear();
    mount();

    expect(mockAtts.items().length).toBe(1);
    expect(mockAtts.items()[0].id).toBe('one');
  });

  it('send() with an attachment drains it and clears the store entry', async () => {
    mount();
    mockAtts._items.set([makePendingAttachment('one')]);
    comp.draft.set('mensaje con imagen');
    fixture.detectChanges();
    expect(store.snapshot('/ws/project-a')).not.toBeNull();

    await comp.send();
    fixture.detectChanges();

    expect(mockAtts.items().length).toBe(0);
    expect(store.snapshot('/ws/project-a')).toBeNull();
  });
});

// ── Auto run-mode reactive on typing ──────────────────────────────────────────

describe('ChatPanelComponent — auto run-mode while typing', () => {
  let fixture: ComponentFixture<ChatPanelComponent>;
  let comp: ChatPanelComponent;
  let mockState: ReturnType<typeof createMockState>;
  let toastMock: { show: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    (globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] =
      MockIntersectionObserver;
    mockState = createMockState();
    toastMock = { show: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: mockState },
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: toastMock },
        { provide: DialogService, useValue: dialogsMock },
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

  function type(text: string): void {
    comp.draft.set(text);
    fixture.detectChanges();
  }

  it('typing an apply verb while in plan switches to apply and toasts', () => {
    mockState._runMode.set('plan');
    type('ejecuta los tests');

    expect(mockState.setRunMode).toHaveBeenCalledWith(expect.any(String), 'apply');
    expect(mockState._runMode()).toBe('apply');
    expect(toastMock.show).toHaveBeenCalledWith('mode.auto_apply_toast', { kind: 'info' });
  });

  it('typing a plan verb while in apply switches to plan and toasts', () => {
    // default mode is 'apply'
    type('planifica la migración');

    expect(mockState._runMode()).toBe('plan');
    expect(toastMock.show).toHaveBeenCalledWith('mode.auto_plan_toast', { kind: 'info' });
  });

  it('an apply verb while NOT in plan never escalates (yolo/apply untouched)', () => {
    mockState._runMode.set('apply-yolo');
    type('aplica los cambios');

    expect(mockState.setRunMode).not.toHaveBeenCalled();
    expect(mockState._runMode()).toBe('apply-yolo');
  });

  it('does not inspect messages of 3 chars or fewer', () => {
    mockState._runMode.set('plan');
    type('run'); // 3 chars

    expect(mockState.setRunMode).not.toHaveBeenCalled();
  });

  it('a manual mode change after an auto-switch survives further typing of the same intent', () => {
    mockState._runMode.set('plan');
    type('ejecuta'); // → apply
    expect(mockState._runMode()).toBe('apply');

    // user manually flips back to plan
    mockState._runMode.set('plan');
    (mockState.setRunMode as ReturnType<typeof vi.fn>).mockClear();

    // keeps typing the SAME apply intent
    type('ejecuta ya');

    // intent did not transition → no re-switch, manual choice preserved
    expect(mockState.setRunMode).not.toHaveBeenCalled();
    expect(mockState._runMode()).toBe('plan');
  });

  it('retyping the intent after clearing below the threshold re-triggers the switch', () => {
    mockState._runMode.set('plan');
    type('ejecuta'); // → apply
    expect(mockState._runMode()).toBe('apply');

    mockState._runMode.set('plan');
    type('ej'); // below threshold → tracker resets to null
    (mockState.setRunMode as ReturnType<typeof vi.fn>).mockClear();

    type('ejecuta'); // fresh transition null → apply
    expect(mockState.setRunMode).toHaveBeenCalledWith(expect.any(String), 'apply');
    expect(mockState._runMode()).toBe('apply');
  });
});

// ── Any-file attachments (drop / paste / picker) ─────────────────────────────

describe('ChatPanelComponent — file attachments intake', () => {
  let comp: ChatPanelComponent;
  let mockAtts: ReturnType<typeof createMockAttachments>;
  let toastMock: { show: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    (globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] =
      MockIntersectionObserver;
    mockAtts = createMockAttachments();
    mockAtts.add.mockReturnValue('att-1');
    toastMock = { show: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [ChatPanelComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: createMockState() },
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: toastMock },
        { provide: DialogService, useValue: dialogsMock },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    })
      .overrideComponent(ChatPanelComponent, {
        set: {
          providers: [
            { provide: PendingAttachmentsService, useValue: mockAtts },
            ChatScrollService,
          ],
        },
      })
      .compileComponents();

    const fixture = TestBed.createComponent(ChatPanelComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });

  const file = (name: string, type: string): File => new File([new Uint8Array([1])], name, { type });

  function clipboard(files: File[], items: Array<{ kind: string; getAsFile: () => File | null }> = []) {
    const preventDefault = vi.fn();
    const event = {
      clipboardData: { files, items, getData: () => '' },
      preventDefault,
    } as unknown as ClipboardEvent;
    return { event, preventDefault };
  }

  it('pasting a non-image file attaches it and swallows the paste', () => {
    const pdf = file('spec.pdf', 'application/pdf');
    const { event, preventDefault } = clipboard([pdf]);
    comp.onPaste(event);
    expect(mockAtts.add).toHaveBeenCalledWith(pdf, 'spec.pdf');
    expect(preventDefault).toHaveBeenCalled();
  });

  it('falls back to clipboard items when files is empty', () => {
    const bin = file('blob.bin', '');
    const { event } = clipboard([], [{ kind: 'file', getAsFile: () => bin }, { kind: 'string', getAsFile: () => null }]);
    comp.onPaste(event);
    expect(mockAtts.add).toHaveBeenCalledTimes(1);
    expect(mockAtts.add).toHaveBeenCalledWith(bin, 'blob.bin');
  });

  it('a text-only paste is left to the textarea', () => {
    const { event, preventDefault } = clipboard([]);
    comp.onPaste(event);
    expect(mockAtts.add).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('dropping files of any type attaches every one', () => {
    const files = [file('a.zip', 'application/zip'), file('b.png', 'image/png')];
    comp.onDrop({ preventDefault: vi.fn(), dataTransfer: { files } } as unknown as DragEvent);
    expect(mockAtts.add).toHaveBeenCalledTimes(2);
  });

  it('warns with a toast for files refused by the size cap', () => {
    mockAtts.add.mockReturnValueOnce(null);
    comp.attachFiles([file('huge.iso', ''), file('ok.txt', 'text/plain')]);
    expect(toastMock.show).toHaveBeenCalledTimes(1);
    expect(toastMock.show.mock.calls[0]![1]).toEqual({ kind: 'warning' });
  });
});
