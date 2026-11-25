/**
 * S-53 — the "this session belongs to another agent" notice, shared by Settings
 * (global default) and the footer picker (project/session agent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { AgentSwitchHandoffService } from './agent-switch-handoff.service';
import { AppStateService } from './app-state.service';
import { ElectronApiService } from './electron-api.service';
import { ToastService } from './toast.service';
import type { ChatMessage } from '../../../../shared/domain/chat';

function setup(opts: { focusedPane?: string | null; operative?: boolean } = {}) {
  const chats = signal(new Map<string, ChatMessage[]>([
    ['/ws/proj', [{ id: 'm1', role: 'assistant', text: 'hi', agentId: 'claude' } as ChatMessage]],
  ]));
  const state = {
    selectedProject: signal<string | null>('/ws/proj'),
    focusedSessionKey: signal<string | null>(opts.focusedPane ?? null),
    mountedPaneSessions: signal<ReadonlySet<string>>(new Set()),
    chats,
    detectedAgents: signal([{ id: 'claude', name: 'Claude Code', selectable: true, authStatus: opts.operative === false ? 'missing' : 'ok' }]),
  };
  const api = { sendInstruction: vi.fn().mockResolvedValue(undefined) };
  const toast = { show: vi.fn() };
  TestBed.configureTestingModule({
    imports: [TranslateModule.forRoot()],
    providers: [
      AgentSwitchHandoffService,
      { provide: AppStateService, useValue: state },
      { provide: ElectronApiService, useValue: api },
      { provide: ToastService, useValue: toast },
    ],
  });
  return { service: TestBed.inject(AgentSwitchHandoffService), api, toast };
}

describe('AgentSwitchHandoffService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('says nothing when the agent did not change', () => {
    const t = setup();
    t.service.notify('claude', 'claude');
    expect(t.toast.show).not.toHaveBeenCalled();
  });

  it('warns when the focused session belongs to the previous agent, offering the summary while that agent is operative', () => {
    const t = setup();
    t.service.notify('claude', 'codex');
    expect(t.toast.show).toHaveBeenCalledOnce();
    const opts = t.toast.show.mock.calls[0]![1] as { action?: { onAction: () => void } };
    expect(opts.action).toBeDefined();
  });

  it('offers no summary action when the previous agent is no longer operative', () => {
    const t = setup({ operative: false });
    t.service.notify('claude', 'codex');
    const opts = t.toast.show.mock.calls[0]![1] as { action?: unknown };
    expect(opts.action).toBeUndefined();
  });

  it('asks the PREVIOUS agent for the summary on the primary pane', () => {
    const t = setup();
    t.service.notify('claude', 'codex');
    (t.toast.show.mock.calls[0]![1] as { action: { onAction: () => void } }).action.onAction();
    expect(t.api.sendInstruction).toHaveBeenCalledWith(
      '/ws/proj', expect.any(String), [], 'apply', expect.any(String), { agentIdOverride: 'claude' },
    );
  });

  it('asks on the focused split pane with its own runKey', () => {
    const t = setup({ focusedPane: 'pane-1' });
    t.service.requestSummaryFrom('claude');
    expect(t.api.sendInstruction).toHaveBeenCalledWith(
      '/ws/proj', expect.any(String), [], 'apply', expect.any(String),
      { runKey: 'pane-1', sessionId: 'pane-1', isolate: false, agentIdOverride: 'claude' },
    );
  });

  it('says nothing when no session belongs to another agent', () => {
    const t = setup();
    t.service.notify('codex', 'claude'); // the chat is already claude's
    expect(t.toast.show).not.toHaveBeenCalled();
  });
});
