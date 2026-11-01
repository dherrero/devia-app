/**
 * S-2 F3.1 — Cross-agent handoff event → persisted divider message.
 *
 * Verifies that a `session:handoff` bridge event becomes a ChatMessage with
 * `kind: 'handoff'` in the session transcript, ordered BEFORE anything the
 * run streams afterwards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { AppStateService } from './app-state.service';
import { ElectronApiService } from './electron-api.service';
import { ToastService } from './toast.service';
import type { SessionHandoffEvent } from '../../../types/devia';

const noop = (): void => undefined;

let handoffCb: ((e: SessionHandoffEvent) => void) | null = null;

const mockApi = new Proxy({} as Record<string, unknown>, {
  get: (target, prop: string) => {
    if (prop === 'platform') return 'linux';
    if (prop === 'isWSL') return false;
    if (prop === 'onSessionHandoff') {
      return (cb: (e: SessionHandoffEvent) => void) => { handoffCb = cb; };
    }
    if (prop === 'getRunModes') return () => Promise.resolve([]);
    if (prop in target) return target[prop];
    return noop;
  },
}) as unknown as ElectronApiService;

const mockToast: Partial<ToastService> = { show: vi.fn() };

describe('AppStateService — session:handoff → divider message (S-2 F3.1)', () => {
  let service: AppStateService;

  beforeEach(async () => {
    handoffCb = null;
    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();
    service = TestBed.inject(AppStateService);
    (service as unknown as { wireBridgeEvents(): void })['wireBridgeEvents']();
  });

  function fire(over: Partial<SessionHandoffEvent> = {}): void {
    expect(handoffCb).not.toBeNull();
    handoffCb!({
      project: '/ws/proj-a',
      fromAgentId: 'codex',
      toAgentId: 'claude',
      summary: '## Continuación de sesión iniciada con codex',
      runId: 'run-1' as SessionHandoffEvent['runId'],
      ...over,
    });
  }

  it('persists a kind:handoff message carrying both agents and the summary as text', () => {
    fire();

    const msgs = service.chats().get('/ws/proj-a') ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      role: 'assistant',
      kind: 'handoff',
      handoff: { fromAgentId: 'codex', toAgentId: 'claude' },
      text: '## Continuación de sesión iniciada con codex',
    });
    expect(msgs[0]!.id).not.toBe('');
  });

  it('keeps the divider ahead of messages appended afterwards (run stream order)', () => {
    fire();
    service.addMessage('/ws/proj-a', { id: 'a1', role: 'assistant', text: 'respuesta del run' });

    const msgs = service.chats().get('/ws/proj-a') ?? [];
    expect(msgs.map((m) => m.kind ?? m.id)).toEqual(['handoff', 'a1']);
  });

  it('routes by run identity (split pane runKey) without touching other sessions', () => {
    fire({ project: 'pane-session-id' });

    expect(service.chats().get('pane-session-id')).toHaveLength(1);
    expect(service.chats().get('/ws/proj-a')).toBeUndefined();
  });
});
