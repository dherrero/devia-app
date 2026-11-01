/**
 * S-13 T-143 — split-view container orchestration.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Component, signal, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TranslateModule } from '@ngx-translate/core';
import { ChatPanesContainerComponent } from './chat-panes-container.component';
import { ChatPanelComponent } from '../chat-panel/chat-panel.component';
import { ComposerDraftStore } from '../composer/composer-draft.store';
import { AppStateService } from '../../../core/services/app-state.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { paneCount } from './panes-layout.model';

// Lightweight stand-in for the heavy ChatPanelComponent so the container can
// be mounted without its full dependency graph.
@Component({ selector: 'ds-chat-panel', standalone: true, template: '' })
class StubChatPanelComponent {
  readonly project = input<string | null>(null);
  readonly runKey = input<string | null>(null);
  readonly sessionId = input<string | null>(null);
  readonly isolate = input<boolean>(false);
  readonly workdir = input<string | null>(null);
  readonly worktreeBranch = input<string | null>(null);
}

function makeState() {
  const _selectedProject = signal<string | null>('/ws/proj-a');
  const _focusedWorkdir = signal<string | null>('/ws/proj-a');
  const _focusedSessionKey = signal<string | null>(null);
  const _paneFocusRequest = signal<string | null>(null);
  const _sessionAdoptRequest = signal<string | null>(null);
  const running = new Set<string>();
  const chats = new Map<string, unknown[]>();
  return {
    _selectedProject,
    selectedProject: _selectedProject.asReadonly(),
    focusedWorkdir: _focusedWorkdir.asReadonly(),
    workdir: () => _focusedWorkdir() ?? _selectedProject(),
    config: () => ({ worktreePerSession: true }),
    isRunning: (k: string) => running.has(k),
    chats: () => chats,
    _chats: chats,
    clearChat: vi.fn(),
    flushSave: vi.fn().mockResolvedValue(undefined),
    focusWorkdir: vi.fn((p: string) => _focusedWorkdir.set(p)),
    focusedSessionKey: _focusedSessionKey.asReadonly(),
    setFocusedSession: vi.fn((k: string | null) => _focusedSessionKey.set(k)),
    setMountedPaneSessions: vi.fn(),
    setSplitActive: vi.fn(),
    paneFocusRequest: _paneFocusRequest.asReadonly(),
    clearPaneFocusRequest: vi.fn(() => _paneFocusRequest.set(null)),
    _paneFocusRequest,
    _running: running,
    // S-2 F5.2 — adoption request + transcript loader + git info for re-keying.
    sessionAdoptRequest: _sessionAdoptRequest.asReadonly(),
    clearSessionAdoptRequest: vi.fn(() => _sessionAdoptRequest.set(null)),
    _sessionAdoptRequest,
    loadSessionIntoKey: vi.fn(),
    gitInfo: () => ({ branch: 'main' }),
  };
}

describe('ChatPanesContainerComponent (S-13 T-143)', () => {
  let state: ReturnType<typeof makeState>;
  let api: {
    stopProject: ReturnType<typeof vi.fn>;
    removeWorktree: ReturnType<typeof vi.fn>;
    cleanupWorktree: ReturnType<typeof vi.fn>;
    addWorktree: ReturnType<typeof vi.fn>;
    getGitInfo: ReturnType<typeof vi.fn>;
    adoptSession: ReturnType<typeof vi.fn>;
  };
  let toast: { show: ReturnType<typeof vi.fn> };

  function build() {
    return TestBed.createComponent(ChatPanesContainerComponent);
  }

  beforeEach(async () => {
    localStorage.clear(); // S-3 F2.3: skeletons must not leak across tests
    state = makeState();
    api = {
      stopProject: vi.fn(),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn((base: string, sid: string) =>
        Promise.resolve({ sessionId: sid, worktreeDir: `/wt/${sid}`, branch: `devia/session-${sid.slice(0, 8)}` }),
      ),
      getGitInfo: vi.fn().mockResolvedValue({ changedCount: 0 }),
      adoptSession: vi.fn(),
    };
    toast = { show: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [ChatPanesContainerComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: state },
        { provide: ElectronApiService, useValue: api },
        { provide: ToastService, useValue: toast },
      ],
    })
      .overrideComponent(ChatPanesContainerComponent, {
        remove: { imports: [ChatPanelComponent] },
        add: { imports: [StubChatPanelComponent] },
      })
      .compileComponents();
  });

  it('starts as a single primary pane with the vertical split icon', () => {
    const c = build().componentInstance;
    expect(paneCount(c.layout())).toBe(1);
    expect(c.splitIcon(0)).toBe('vertical');
    expect(c.runKeyFor(c.layout().columns[0].panes[0])).toBeNull();
  });

  it('vertical split creates an isolated additional pane in its own worktree', async () => {
    const c = build().componentInstance;
    await c.onSplit(0);
    expect(c.layout().columns.length).toBe(2);
    const added = c.layout().columns[1].panes[0];
    expect(c.runKeyFor(added)).toBe(added.sessionRef.sessionId);
    expect(added.id).not.toBe('primary');
    // Eager worktree creation → workdir is the worktree, pane is isolated.
    expect(api.addWorktree).toHaveBeenCalledWith('/ws/proj-a', added.sessionRef.sessionId);
    expect(added.sessionRef.workdir).toBe(`/wt/${added.sessionRef.sessionId}`);
    expect(c.isolatedFor(added)).toBe(true);
    expect(c.splitIcon(0)).toBe('horizontal');
    expect(c.splitIcon(1)).toBe('horizontal');
  });

  it('S-3 F1.1: isolation is mandatory — the worktree is created even with the legacy flag OFF', async () => {
    (state as { config: () => { worktreePerSession: boolean } }).config =
      () => ({ worktreePerSession: false });
    const c = build().componentInstance;

    await c.onSplit(0);

    const added = c.layout().columns[1].panes[0];
    expect(api.addWorktree).toHaveBeenCalledWith('/ws/proj-a', added.sessionRef.sessionId);
    expect(c.isolatedFor(added)).toBe(true);
  });

  it('S-3 F1.1: a failed worktree degrades VISIBLY — base workdir + [isolate]=false on the pane', async () => {
    api.addWorktree.mockRejectedValue(new Error('not a git repo'));
    const fixture = build();
    fixture.detectChanges();
    const c = fixture.componentInstance;

    await c.onSplit(0);
    fixture.detectChanges();

    const added = c.layout().columns.flatMap((col) => col.panes).find((p) => p.id !== 'primary')!;
    expect(added.sessionRef.workdir).toBe('/ws/proj-a');
    // The panel derives `unisolated` from runKey + !isolate and renders the
    // warning icon in its header (covered by the ChatHeaderComponent spec).
    expect(c.isolatedFor(added)).toBe(false);
    const panes = fixture.debugElement.queryAll(By.directive(StubChatPanelComponent));
    const addedPane = panes.map((d) => d.componentInstance as StubChatPanelComponent)
      .find((p) => p.runKey() !== null)!;
    expect(addedPane.isolate()).toBe(false);
  });

  it('S-3 F1.1: an isolated pane mounts with [isolate]=true (no warning in its header)', async () => {
    const fixture = build();
    fixture.detectChanges();
    const c = fixture.componentInstance;

    await c.onSplit(0);
    fixture.detectChanges();

    const added = c.layout().columns.flatMap((col) => col.panes).find((p) => p.id !== 'primary')!;
    expect(c.isolatedFor(added)).toBe(true);
    const panes = fixture.debugElement.queryAll(By.directive(StubChatPanelComponent));
    const addedPane = panes.map((d) => d.componentInstance as StubChatPanelComponent)
      .find((p) => p.runKey() !== null)!;
    expect(addedPane.isolate()).toBe(true);
  });

  it('focuses the new pane and points the right-rail at its worktree', async () => {
    const c = build().componentInstance;
    await c.onSplit(0);
    const added = c.layout().columns[1].panes[0];
    expect(c.focusedPaneId()).toBe(added.id);
    expect(state.focusWorkdir).toHaveBeenCalledWith(added.sessionRef.workdir);

    // Focusing the primary points it back at the base project.
    c.onFocus('primary');
    expect(state.focusWorkdir).toHaveBeenLastCalledWith('/ws/proj-a');
  });

  it('reaches the 2x2 cap (4 panes) and hides further split icons', async () => {
    const c = build().componentInstance;
    await c.onSplit(0); // 2
    await c.onSplit(0); // 3 (split col 0 into rows)
    await c.onSplit(1); // 4
    expect(paneCount(c.layout())).toBe(4);
    expect(c.splitIcon(0)).toBe('none');
    expect(c.splitIcon(1)).toBe('none');
  });

  it('closing an UNTOUCHED pane (zero activity) tears down worktree AND branch', async () => {
    const c = build().componentInstance;
    await c.onSplit(0);
    const pane = c.layout().columns[1].panes[0];
    await c.onRequestClose(pane);
    expect(c.pendingClose()).toBeNull();
    expect(api.stopProject).toHaveBeenCalledWith(pane.sessionRef.sessionId);
    expect(api.cleanupWorktree).toHaveBeenCalledWith('/ws/proj-a', pane.sessionRef.sessionId);
    expect(api.removeWorktree).not.toHaveBeenCalled();
    expect(paneCount(c.layout())).toBe(1);
  });

  it('closing a pane WITH activity removes only the worktree — the branch survives for recovery', async () => {
    const c = build().componentInstance;
    await c.onSplit(0);
    const pane = c.layout().columns[1].panes[0];
    state._chats.set(pane.sessionRef.sessionId, [{ id: 'm1', role: 'user' }]);
    await c.onRequestClose(pane);
    expect(api.removeWorktree).toHaveBeenCalledWith('/ws/proj-a', pane.sessionRef.sessionId);
    expect(api.cleanupWorktree).not.toHaveBeenCalled();
    expect(paneCount(c.layout())).toBe(1);
  });

  it('closing a RUNNING pane opens the confirm modal; confirm then closes it', async () => {
    const c = build().componentInstance;
    await c.onSplit(0);
    const pane = c.layout().columns[1].panes[0];
    state._running.add(pane.sessionRef.sessionId);

    await c.onRequestClose(pane);
    expect(c.pendingClose()?.id).toBe(pane.id); // modal shown, not closed yet
    expect(paneCount(c.layout())).toBe(2);

    c.confirmClose();
    // closePane awaits flushSave + removeWorktree — give the macrotask queue a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.stopProject).toHaveBeenCalledWith(pane.sessionRef.sessionId);
    expect(paneCount(c.layout())).toBe(1);
  });

  it('closing a pane with a DIRTY worktree opens the confirm modal (work-loss guard)', async () => {
    api.getGitInfo.mockResolvedValue({ changedCount: 3 }); // uncommitted changes
    const c = build().componentInstance;
    await c.onSplit(0);
    const pane = c.layout().columns[1].panes[0];
    // not running, but dirty → modal, not an immediate close
    await c.onRequestClose(pane);
    expect(c.pendingClose()?.id).toBe(pane.id);
    expect(paneCount(c.layout())).toBe(2);
    expect(api.stopProject).not.toHaveBeenCalled();
  });

  it('the primary pane cannot be closed', async () => {
    const c = build().componentInstance;
    const primary = c.layout().columns[0].panes[0];
    await c.onRequestClose(primary);
    expect(paneCount(c.layout())).toBe(1);
    expect(api.stopProject).not.toHaveBeenCalled();
  });

  it('switching projects preserves each project split and kills nothing on navigation', async () => {
    const c = build();
    const inst = c.componentInstance;
    c.detectChanges();

    await inst.onSplit(0);
    expect(paneCount(inst.layout())).toBe(2);
    const aPaneId = inst.layout().columns[1].panes[0].id;

    state._selectedProject.set('/ws/proj-b');
    c.detectChanges();
    expect(paneCount(inst.layout())).toBe(1);
    expect(api.stopProject).not.toHaveBeenCalled();
    expect(api.removeWorktree).not.toHaveBeenCalled();

    state._selectedProject.set('/ws/proj-a');
    c.detectChanges();
    expect(paneCount(inst.layout())).toBe(2);
    expect(inst.layout().columns[1].panes[0].id).toBe(aPaneId);
    expect(api.stopProject).not.toHaveBeenCalled();
  });

  it('restores the split after the container is destroyed + recreated (route change)', async () => {
    const c1 = build();
    c1.detectChanges();
    await c1.componentInstance.onSplit(0);
    expect(paneCount(c1.componentInstance.layout())).toBe(2);

    c1.destroy();
    const c2 = build();
    c2.detectChanges();
    expect(paneCount(c2.componentInstance.layout())).toBe(2);
  });

  it('publishes mounted sessions + focuses on a sidebar focus request (T-157)', async () => {
    const c = build();
    const inst = c.componentInstance;
    c.detectChanges();
    await inst.onSplit(0);
    const added = inst.layout().columns[1].panes[0];

    // The container told the shell which additional sessions are on screen.
    expect(state.setMountedPaneSessions).toHaveBeenCalled();
    const lastSet = state.setMountedPaneSessions.mock.calls.at(-1)![0] as ReadonlySet<string>;
    expect(lastSet.has(added.sessionRef.sessionId)).toBe(true);

    // Re-focus the primary, then have the sidebar request the additional pane.
    inst.onFocus('primary');
    expect(inst.focusedPaneId()).toBe('primary');

    state._paneFocusRequest.set(added.sessionRef.sessionId);
    c.detectChanges();

    expect(inst.focusedPaneId()).toBe(added.id);
    expect(state.clearPaneFocusRequest).toHaveBeenCalled();
  });

  it('flags splitActive on split and clears it when back to one pane (T-158)', async () => {
    const c = build();
    const inst = c.componentInstance;
    c.detectChanges();
    // Seeded as single pane → no split.
    expect(state.setSplitActive).toHaveBeenLastCalledWith(false);

    await inst.onSplit(0);
    expect(state.setSplitActive).toHaveBeenLastCalledWith(true);

    const added = inst.layout().columns[1].panes[0];
    await inst.onRequestClose(added);
    expect(state.setSplitActive).toHaveBeenLastCalledWith(false);
  });
});

describe('ChatPanesContainerComponent — session adoption (S-2 F5.2)', () => {
  // Re-uses the suite-level beforeEach state/api/toast via closure is not
  // possible across describes — this block builds its own TestBed identically.
  let state: ReturnType<typeof makeState>;
  let api: {
    stopProject: ReturnType<typeof vi.fn>;
    removeWorktree: ReturnType<typeof vi.fn>;
    cleanupWorktree: ReturnType<typeof vi.fn>;
    addWorktree: ReturnType<typeof vi.fn>;
    getGitInfo: ReturnType<typeof vi.fn>;
    adoptSession: ReturnType<typeof vi.fn>;
  };
  let toast: { show: ReturnType<typeof vi.fn> };

  const ADOPTED = '99999999-9999-4999-8999-999999999999';

  beforeEach(async () => {
    localStorage.clear(); // S-3 F2.3: skeletons must not leak across tests
    state = makeState();
    api = {
      stopProject: vi.fn(),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn((base: string, sid: string) =>
        Promise.resolve({ sessionId: sid, worktreeDir: `/wt/${sid}`, branch: `devia/session-${sid.slice(0, 8)}` }),
      ),
      getGitInfo: vi.fn().mockResolvedValue({ changedCount: 0 }),
      adoptSession: vi.fn().mockResolvedValue({
        id: ADOPTED,
        messages: [{ id: 'm', role: 'user' }],
        workdir: '/ws/proj-a',
        isolation: 'none',
      }),
    };
    toast = { show: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [ChatPanesContainerComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: state },
        { provide: ElectronApiService, useValue: api },
        { provide: ToastService, useValue: toast },
      ],
    })
      .overrideComponent(ChatPanesContainerComponent, {
        remove: { imports: [ChatPanelComponent] },
        add: { imports: [StubChatPanelComponent] },
      })
      .compileComponents();
  });

  async function buildSplit() {
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    await c.onSplit(0);
    fixture.detectChanges();
    return { fixture, c };
  }

  async function requestAdoption(fixture: ReturnType<typeof TestBed.createComponent<ChatPanesContainerComponent>>) {
    state._sessionAdoptRequest.set(ADOPTED);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  }

  it('adopts a free session into the focused additional pane, re-keying it to the session id', async () => {
    const { fixture, c } = await buildSplit();
    const oldPane = c.layout().columns.flatMap((col) => col.panes).find((p) => p.id !== 'primary')!;

    await requestAdoption(fixture);

    expect(api.adoptSession).toHaveBeenCalledWith('/ws/proj-a', ADOPTED, ADOPTED);
    const panes = c.layout().columns.flatMap((col) => col.panes);
    const adopted = panes.find((p) => p.id === ADOPTED);
    expect(adopted).toBeDefined();
    // runKey === sessionRef.sessionId invariant + base checkout (no isolation).
    expect(c.runKeyFor(adopted!)).toBe(ADOPTED);
    expect(adopted!.sessionRef.workdir).toBe('/ws/proj-a');
    expect(c.isolatedFor(adopted!)).toBe(false);
    expect(c.layout().focusedPaneId).toBe(ADOPTED);
    // Transcript loaded under the new key; old blank pane FULLY cleaned up
    // (zero activity → worktree + branch, S-3).
    expect(state.loadSessionIntoKey).toHaveBeenCalledWith(ADOPTED, [{ id: 'm', role: 'user' }], undefined, undefined);
    expect(api.cleanupWorktree).toHaveBeenCalledWith('/ws/proj-a', oldPane.sessionRef.sessionId);
    expect(state.clearChat).toHaveBeenCalledWith(oldPane.sessionRef.sessionId);
    // mountedPaneSessions now advertises the adopted id (active marker moves).
    const lastMounted = state.setMountedPaneSessions.mock.calls.at(-1)?.[0] as Set<string>;
    expect(lastMounted.has(ADOPTED)).toBe(true);
  });

  it('S-3 F2.2: a recovered worktree re-keys the pane onto it (isolated again)', async () => {
    api.adoptSession.mockResolvedValue({
      id: ADOPTED,
      messages: [],
      workdir: `/wt/${ADOPTED}`,
      branch: 'devia/session-9999',
      isolation: 'worktree',
    });
    const { fixture, c } = await buildSplit();

    await requestAdoption(fixture);

    const adopted = c.layout().columns.flatMap((col) => col.panes).find((p) => p.id === ADOPTED)!;
    expect(adopted.sessionRef.workdir).toBe(`/wt/${ADOPTED}`);
    expect(adopted.sessionRef.branch).toBe('devia/session-9999');
    expect(c.isolatedFor(adopted)).toBe(true);
  });

  it('S-3 F2.2: a RECREATED worktree informs about the lost uncommitted work', async () => {
    api.adoptSession.mockResolvedValue({
      id: ADOPTED,
      messages: [],
      workdir: `/wt/${ADOPTED}`,
      branch: 'devia/session-9999',
      isolation: 'recreated',
    });
    const { fixture } = await buildSplit();

    await requestAdoption(fixture);

    expect(toast.show).toHaveBeenCalledWith(expect.any(String), { kind: 'info', durationMs: 8000 });
  });

  it('keeps the old pane and warns when main rejects with SESSION_BUSY', async () => {
    api.adoptSession.mockRejectedValue(new Error("Error invoking remote method 'session:adopt': Error: SESSION_BUSY"));
    const { fixture, c } = await buildSplit();
    const before = c.layout();

    await requestAdoption(fixture);

    expect(toast.show).toHaveBeenCalledWith(expect.any(String), { kind: 'warning' });
    expect(c.layout()).toBe(before);
    expect(state.loadSessionIntoKey).not.toHaveBeenCalled();
  });

  it('a running old pane keeps its worktree and live chat', async () => {
    const { fixture, c } = await buildSplit();
    const oldPane = c.layout().columns.flatMap((col) => col.panes).find((p) => p.id !== 'primary')!;
    state._running.add(oldPane.sessionRef.sessionId);

    await requestAdoption(fixture);

    expect(api.removeWorktree).not.toHaveBeenCalledWith('/ws/proj-a', oldPane.sessionRef.sessionId);
    expect(api.cleanupWorktree).not.toHaveBeenCalledWith('/ws/proj-a', oldPane.sessionRef.sessionId);
    expect(state.clearChat).not.toHaveBeenCalled();
  });

  it('never adopts into the primary pane', async () => {
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    fixture.detectChanges(); // single pane — primary focused

    state._sessionAdoptRequest.set(ADOPTED);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));

    expect(api.adoptSession).not.toHaveBeenCalled();
  });

  it("the 'primary' focus sentinel focuses the primary pane", async () => {
    const { fixture, c } = await buildSplit();
    expect(c.layout().focusedPaneId).not.toBe('primary');

    state._paneFocusRequest.set('primary');
    fixture.detectChanges();

    expect(c.layout().focusedPaneId).toBe('primary');
  });
});

describe('ChatPanesContainerComponent — pane close persistence (S-2 F5.3)', () => {
  let state: ReturnType<typeof makeState>;
  let api: {
    stopProject: ReturnType<typeof vi.fn>;
    removeWorktree: ReturnType<typeof vi.fn>;
    cleanupWorktree: ReturnType<typeof vi.fn>;
    addWorktree: ReturnType<typeof vi.fn>;
    getGitInfo: ReturnType<typeof vi.fn>;
    adoptSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    localStorage.clear(); // S-3 F2.3: skeletons must not leak across tests
    state = makeState();
    api = {
      stopProject: vi.fn(),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn((base: string, sid: string) =>
        Promise.resolve({ sessionId: sid, worktreeDir: `/wt/${sid}`, branch: 'b' }),
      ),
      getGitInfo: vi.fn().mockResolvedValue({ changedCount: 0 }),
      adoptSession: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [ChatPanesContainerComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: state },
        { provide: ElectronApiService, useValue: api },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    })
      .overrideComponent(ChatPanesContainerComponent, {
        remove: { imports: [ChatPanelComponent] },
        add: { imports: [StubChatPanelComponent] },
      })
      .compileComponents();
  });

  it('flushes the pending save BEFORE clearing the chat on close (last message survives)', async () => {
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    await c.onSplit(0);
    const pane = c.layout().columns.flatMap((col) => col.panes).find((p) => p.id !== 'primary')!;

    await c.onRequestClose(pane);

    const key = pane.sessionRef.sessionId;
    expect(state.flushSave).toHaveBeenCalledWith(key);
    expect(state.clearChat).toHaveBeenCalledWith(key);
    const flushOrder = state.flushSave.mock.invocationCallOrder[0]!;
    const clearOrder = state.clearChat.mock.invocationCallOrder[0]!;
    expect(flushOrder).toBeLessThan(clearOrder);
    // The session stays persisted on disk and merely loses its mounted badge
    // (publishShellState drops it from mountedPaneSessions).
    const lastMounted = state.setMountedPaneSessions.mock.calls.at(-1)?.[0] as Set<string>;
    expect(lastMounted.has(key)).toBe(false);
  });
});

describe('ChatPanesContainerComponent — split restore from disk (S-3 F2.3)', () => {
  let state: ReturnType<typeof makeState>;
  let api: {
    stopProject: ReturnType<typeof vi.fn>;
    removeWorktree: ReturnType<typeof vi.fn>;
    cleanupWorktree: ReturnType<typeof vi.fn>;
    addWorktree: ReturnType<typeof vi.fn>;
    getGitInfo: ReturnType<typeof vi.fn>;
    adoptSession: ReturnType<typeof vi.fn>;
  };

  const SID2 = '22222222-2222-4222-8222-222222222222';
  const SKELETON_KEY = 'devia.panesLayout./ws/proj-a';

  beforeEach(async () => {
    localStorage.clear();
    state = makeState();
    api = {
      stopProject: vi.fn(),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue({ sessionId: 'x', worktreeDir: '/wt/x', branch: 'b' }),
      getGitInfo: vi.fn().mockResolvedValue({ changedCount: 0 }),
      adoptSession: vi.fn().mockResolvedValue({
        id: SID2,
        messages: [{ id: 'm', role: 'user' }],
        workdir: `/wt/${SID2}`,
        branch: 'devia/session-2222',
        isolation: 'worktree',
      }),
    };
    await TestBed.configureTestingModule({
      imports: [ChatPanesContainerComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: state },
        { provide: ElectronApiService, useValue: api },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    })
      .overrideComponent(ChatPanesContainerComponent, {
        remove: { imports: [ChatPanelComponent] },
        add: { imports: [StubChatPanelComponent] },
      })
      .compileComponents();
  });

  function seedSkeleton(): void {
    localStorage.setItem(SKELETON_KEY, JSON.stringify({
      columns: [{ panes: [null] }, { panes: [SID2] }],
      focusedSessionId: SID2,
    }));
  }

  async function settle(fixture: ReturnType<typeof TestBed.createComponent<ChatPanesContainerComponent>>) {
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  }

  it('rebuilds the persisted split through the ADOPTION path (recovery chain applies)', async () => {
    seedSkeleton();
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    const c = fixture.componentInstance;
    await settle(fixture);

    expect(api.adoptSession).toHaveBeenCalledWith('/ws/proj-a', SID2, SID2);
    const panes = c.layout().columns.flatMap((col) => col.panes);
    expect(panes).toHaveLength(2);
    const restored = panes.find((p) => p.id === SID2)!;
    expect(restored.sessionRef.workdir).toBe(`/wt/${SID2}`);
    expect(c.isolatedFor(restored)).toBe(true);
    expect(c.layout().focusedPaneId).toBe(SID2);
    expect(state.loadSessionIntoKey).toHaveBeenCalledWith(SID2, [{ id: 'm', role: 'user' }], undefined, undefined);
  });

  it('a vanished session is skipped and the leftover single-pane skeleton is cleared', async () => {
    seedSkeleton();
    api.adoptSession.mockRejectedValue(new Error('La sesión no existe'));
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    const c = fixture.componentInstance;
    await settle(fixture);

    expect(c.layout().columns.flatMap((col) => col.panes)).toHaveLength(1);
    expect(localStorage.getItem(SKELETON_KEY)).toBeNull();
  });

  it('no skeleton → single pane, no adoption attempted (zero regression)', async () => {
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    const c = fixture.componentInstance;
    await settle(fixture);

    expect(c.layout().columns.flatMap((col) => col.panes)).toHaveLength(1);
    expect(api.adoptSession).not.toHaveBeenCalled();
  });

  it('committing a layout persists its skeleton (split survives a restart)', async () => {
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    const c = fixture.componentInstance;
    fixture.detectChanges();

    await c.onSplit(0);

    const raw = localStorage.getItem(SKELETON_KEY);
    expect(raw).not.toBeNull();
    const skeleton = JSON.parse(raw!) as { columns: Array<{ panes: Array<string | null> }> };
    expect(skeleton.columns.flatMap((col) => col.panes)).toHaveLength(2);
    expect(skeleton.columns[0]!.panes[0]).toBeNull(); // primary slot
  });
});

describe('ChatPanesContainerComponent — composer draft purge on close (S-14 T-162)', () => {
  let state: ReturnType<typeof makeState>;
  let api: {
    stopProject: ReturnType<typeof vi.fn>;
    removeWorktree: ReturnType<typeof vi.fn>;
    cleanupWorktree: ReturnType<typeof vi.fn>;
    addWorktree: ReturnType<typeof vi.fn>;
    getGitInfo: ReturnType<typeof vi.fn>;
    adoptSession: ReturnType<typeof vi.fn>;
  };
  let drafts: ComposerDraftStore;

  beforeEach(async () => {
    localStorage.clear();
    state = makeState();
    api = {
      stopProject: vi.fn(),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn((base: string, sid: string) =>
        Promise.resolve({ sessionId: sid, worktreeDir: `/wt/${sid}`, branch: 'b' }),
      ),
      getGitInfo: vi.fn().mockResolvedValue({ changedCount: 0 }),
      adoptSession: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [ChatPanesContainerComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: state },
        { provide: ElectronApiService, useValue: api },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    })
      .overrideComponent(ChatPanesContainerComponent, {
        remove: { imports: [ChatPanelComponent] },
        add: { imports: [StubChatPanelComponent] },
      })
      .compileComponents();
    drafts = TestBed.inject(ComposerDraftStore);
  });

  async function splitAndGetPane(c: ChatPanesContainerComponent) {
    await c.onSplit(0);
    return c.layout().columns.flatMap((col) => col.panes).find((p) => p.id !== 'primary')!;
  }

  it('closing a pane purges its draft from the store', async () => {
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    const pane = await splitAndGetPane(c);
    const key = c.runKeyFor(pane)!;
    drafts.save(key, { draft: 'borrador del split', attachments: [] });

    await c.onRequestClose(pane);

    expect(drafts.snapshot(key)).toBeNull();
  });

  it('the panel destroy-save firing AFTER the close cannot resurrect the entry', async () => {
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    const pane = await splitAndGetPane(c);
    const key = c.runKeyFor(pane)!;
    drafts.save(key, { draft: 'borrador vivo', attachments: [] });

    await c.onRequestClose(pane);
    // The pane's ChatPanelComponent is destroyed by the next CD cycle and its
    // DestroyRef hook saves the final composer state — it must be a no-op.
    drafts.save(key, { draft: 'borrador vivo', attachments: [] });

    expect(drafts.snapshot(key)).toBeNull();
  });

  it('adopting a session into a pane purges the previous key draft', async () => {
    api.adoptSession.mockResolvedValue({
      id: 'adopted-sid',
      messages: [],
      workdir: '/wt/adopted-sid',
      branch: 'devia/session-adopt',
      isolation: 'worktree',
    });
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    const pane = await splitAndGetPane(c); // split focuses the new pane
    const oldKey = c.runKeyFor(pane)!;
    drafts.save(oldKey, { draft: 'borrador previo', attachments: [] });

    await (c as unknown as {
      adoptIntoFocusedPane(sessionId: string): Promise<void>;
    }).adoptIntoFocusedPane('adopted-sid');

    expect(drafts.snapshot(oldKey)).toBeNull();
  });

  it('closing the primary pane request is a no-op and keeps its draft', async () => {
    const fixture = TestBed.createComponent(ChatPanesContainerComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    const primary = c.layout().columns[0]!.panes[0]!;
    drafts.save('/ws/proj-a', { draft: 'borrador primario', attachments: [] });

    await c.onRequestClose(primary);

    expect(drafts.snapshot('/ws/proj-a')?.draft).toBe('borrador primario');
  });
});
