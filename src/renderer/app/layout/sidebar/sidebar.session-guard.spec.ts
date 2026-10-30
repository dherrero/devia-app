/**
 * S-2 F0.3 — UI guard: switching/deleting a session while an agent works in
 * the destination pane is blocked with a toast; focusing a mounted session
 * stays allowed. The template is overridden — these tests exercise the
 * component's routing logic only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { of } from 'rxjs';
import { SidebarComponent } from './sidebar.component';
import { AppStateService } from '../../core/services/app-state.service';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { ToastService } from '../../core/services/toast.service';
import { DialogService } from '@devia/ui';
import { KanbanStateService } from '../../features/kanban/services/kanban-state.service';
import type { SessionMeta } from '../../../types/devia';

function makeSession(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess-1', createdAt: 1, updatedAt: 2, messageCount: 3,
    preview: 'hola', isActive: false, ...over,
  };
}

describe('SidebarComponent — session switch/delete guards (S-2 F0.3)', () => {
  let fixture: ComponentFixture<SidebarComponent>;
  let component: SidebarComponent;
  let state: {
    selectedProject: ReturnType<typeof signal<string | null>>;
    focusedSessionKey: ReturnType<typeof signal<string | null>>;
    running: Set<string>;
    config: ReturnType<typeof signal<{ agentId: string }>>;
    splitActive: ReturnType<typeof signal<boolean>>;
    isSessionMounted: ReturnType<typeof vi.fn>;
    isSessionFocused: ReturnType<typeof vi.fn>;
    requestPaneFocus: ReturnType<typeof vi.fn>;
    requestSessionAdopt: ReturnType<typeof vi.fn>;
    switchSession: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
    isRunning: (key: string) => boolean;
    canSwitchSession: (id: string) => { ok: true } | { ok: false; reason: 'destination-running' };
  };
  let toast: { show: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    const selectedProject = signal<string | null>('/ws/proj');
    const focusedSessionKey = signal<string | null>(null);
    const running = new Set<string>();
    const isRunning = (key: string) => running.has(key);
    state = {
      selectedProject,
      focusedSessionKey,
      running,
      config: signal({ agentId: 'claude' }),
      splitActive: signal(false),
      isSessionMounted: vi.fn(() => false),
      isSessionFocused: vi.fn(() => false),
      requestPaneFocus: vi.fn(),
      requestSessionAdopt: vi.fn(),
      switchSession: vi.fn(),
      deleteSession: vi.fn(),
      isRunning,
      canSwitchSession: (id: string) => {
        void id;
        const destination = focusedSessionKey() ?? selectedProject();
        return destination !== null && isRunning(destination)
          ? { ok: false, reason: 'destination-running' }
          : { ok: true };
      },
    };
    toast = { show: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [SidebarComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: state },
        { provide: ElectronApiService, useValue: {} },
        { provide: ToastService, useValue: toast },
        { provide: DialogService, useValue: { confirm: vi.fn() } },
        { provide: KanbanStateService, useValue: {} },
        { provide: Dialog, useValue: {} },
      ],
    })
      .overrideComponent(SidebarComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    fixture = TestBed.createComponent(SidebarComponent);
    component = fixture.componentInstance;
  });

  it('busy destination (primary) → no switch and a warning toast', () => {
    state.running.add('/ws/proj');

    component.openSession(makeSession());

    expect(state.switchSession).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith(expect.any(String), { kind: 'warning' });
  });

  it('idle destination → normal switch flow', () => {
    component.openSession(makeSession());

    expect(state.switchSession).toHaveBeenCalledWith('/ws/proj', 'sess-1');
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('session mounted in another pane → focus is allowed even while that pane runs (+ feedback toast, F5.2)', () => {
    state.isSessionMounted.mockReturnValue(true);
    state.running.add('sess-1');

    component.openSession(makeSession());

    expect(state.requestPaneFocus).toHaveBeenCalledWith('sess-1');
    expect(state.switchSession).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith(expect.any(String), { kind: 'warning' });
  });

  it('clicking the session of the FOCUSED pane focuses silently (no toast)', () => {
    state.isSessionMounted.mockReturnValue(true);
    state.focusedSessionKey.set('sess-1');

    component.openSession(makeSession());

    expect(state.requestPaneFocus).toHaveBeenCalledWith('sess-1');
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('split: free session with an additional pane focused → adoption request (F5.2)', () => {
    state.focusedSessionKey.set('pane-key');

    component.openSession(makeSession());

    expect(state.requestSessionAdopt).toHaveBeenCalledWith('sess-1');
    expect(state.switchSession).not.toHaveBeenCalled();
  });

  it("split: the primary's ACTIVE session clicked from an additional pane → toast + focus primary (F5.2)", () => {
    state.focusedSessionKey.set('pane-key');

    component.openSession(makeSession({ isActive: true }));

    expect(state.requestSessionAdopt).not.toHaveBeenCalled();
    expect(state.requestPaneFocus).toHaveBeenCalledWith('primary');
    expect(toast.show).toHaveBeenCalledWith(expect.any(String), { kind: 'warning' });
  });

  it('split: focused ADDITIONAL pane running → switch blocked', () => {
    state.focusedSessionKey.set('pane-key');
    state.running.add('pane-key');

    component.openSession(makeSession());

    expect(state.switchSession).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalled();
  });

  it('clicking the already-active session of the primary is a silent no-op', () => {
    component.openSession(makeSession({ isActive: true }));

    expect(state.switchSession).not.toHaveBeenCalled();
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('deleting the ACTIVE session while its project runs → blocked with toast', async () => {
    state.running.add('/ws/proj');

    await component.deleteSession('/ws/proj', makeSession({ isActive: true }));

    expect(state.deleteSession).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith(expect.any(String), { kind: 'warning' });
  });

  it('deleting a NON-active session while the project runs stays allowed (reaches confirm)', async () => {
    state.running.add('/ws/proj');
    const dialogs = TestBed.inject(DialogService) as unknown as { confirm: ReturnType<typeof vi.fn> };
    dialogs.confirm.mockReturnValue(of(false));

    await component.deleteSession('/ws/proj', makeSession({ isActive: false }));

    expect(toast.show).not.toHaveBeenCalled();
  });

  describe('focused-pane accent (S-2 F5.4)', () => {
    it('marks only the focused session, and only while a split is active', () => {
      const session = makeSession();

      state.splitActive.set(false);
      state.isSessionFocused.mockReturnValue(true);
      expect(component.sessionAccent(session)).toBe(false);

      state.splitActive.set(true);
      expect(component.sessionAccent(session)).toBe(true);

      state.isSessionFocused.mockReturnValue(false);
      expect(component.sessionAccent(session)).toBe(false);
    });
  });

  describe('agent badge (S-2 F1.2)', () => {
    it('maps the agent id to its catalog label and detects mismatches', () => {
      const codexSession = makeSession({ agentId: 'codex' });
      expect(component.agentBadge(codexSession)).toBe('Codex');
      expect(component.agentMismatch(codexSession)).toBe(true);

      const claudeSession = makeSession({ agentId: 'claude' });
      expect(component.agentBadge(claudeSession)).toBe('Claude Code');
      expect(component.agentMismatch(claudeSession)).toBe(false);
    });

    it('renders no badge for sessions without identity', () => {
      const legacy = makeSession();
      expect(component.agentBadge(legacy)).toBeNull();
      expect(component.agentMismatch(legacy)).toBe(false);
    });
  });
});
