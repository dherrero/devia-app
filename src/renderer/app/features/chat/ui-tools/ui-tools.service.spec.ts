import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UiToolRequestEvent } from '../../../../../shared/contracts/events';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { AppStateService } from '../../../core/services/app-state.service';
import { ToastService } from '../../../core/services/toast.service';
import { UiToolsService } from './ui-tools.service';

let emit: (e: UiToolRequestEvent) => void = () => undefined;
const sendUiToolResult = vi.fn();
const toastShow = vi.fn();
const upsertTodoMessage = vi.fn();
const addMessage = vi.fn();
const runningPaths = signal<ReadonlySet<string>>(new Set());

function request(over: Partial<UiToolRequestEvent> = {}): UiToolRequestEvent {
  return {
    project: 'proj-a',
    callId: 'c1',
    tool: 'confirm',
    input: { action: 'rm -rf dist' },
    expectsAnswer: true,
    ...over,
  };
}

function todo(callId: string, items: { id: string; text: string; status: string }[]): UiToolRequestEvent {
  return request({ callId, tool: 'todo', expectsAnswer: false, input: { items } });
}

const PLAN_INPUT = {
  title: 'T',
  plan: 'cuerpo',
  steps: ['uno', 'dos'],
};

describe('UiToolsService (S-25)', () => {
  let service: UiToolsService;

  beforeEach(() => {
    sendUiToolResult.mockClear();
    toastShow.mockClear();
    upsertTodoMessage.mockClear();
    addMessage.mockClear();
    runningPaths.set(new Set());
    TestBed.configureTestingModule({
      providers: [
        UiToolsService,
        { provide: ToastService, useValue: { show: toastShow } },
        { provide: AppStateService, useValue: { upsertTodoMessage, addMessage, runningPaths, appendPlanMessage: vi.fn() } },
        {
          provide: ElectronApiService,
          useValue: {
            onUiToolRequest: (cb: (e: UiToolRequestEvent) => void) => {
              emit = cb;
            },
            sendUiToolResult,
          },
        },
      ],
    });
    service = TestBed.inject(UiToolsService);
  });

  it('routes a request to the session that owns the run', () => {
    emit(request({ project: 'pane-1' }));

    expect(service.requestsFor('pane-1')).toHaveLength(1);
    expect(service.requestsFor('proj-a')).toHaveLength(0);
  });

  // S-28 T-334
  it('never brings back a card that was already answered', () => {
    emit(request({ callId: 'a' }));
    service.resolve('proj-a', 'a', 'yes');
    emit(request({ callId: 'a' }));

    expect(service.requestsFor('proj-a')).toHaveLength(0);
  });

  it('never brings back a card that was dropped', () => {
    emit(request({ callId: 'a' }));
    service.drop('proj-a', 'a');
    emit(request({ callId: 'a' }));

    expect(service.requestsFor('proj-a')).toHaveLength(0);
  });

  it('empties a session panel when its run ends, leaving other sessions alone', () => {
    runningPaths.set(new Set(['proj-a', 'pane-1']));
    TestBed.tick();
    emit(request({
      callId: 't1',
      tool: 'todo',
      expectsAnswer: false,
      input: { items: [{ id: '1', text: 'uno', status: 'pending' }] },
    }));
    emit(request({ project: 'pane-1', callId: 'c9' }));

    runningPaths.set(new Set(['pane-1']));
    TestBed.tick();

    expect(service.requestsFor('proj-a')).toHaveLength(0);
    expect(service.requestsFor('pane-1')).toHaveLength(1);
    // The thread copy of the list is history and is not touched.
    expect(upsertTodoMessage).toHaveBeenCalledOnce();
  });

  it('accepts a reused callId in a new run once the old one was cleared', () => {
    emit(request({ callId: 'a' }));
    service.resolve('proj-a', 'a', 'yes');
    service.clear('proj-a');
    emit(request({ callId: 'a' }));

    expect(service.requestsFor('proj-a')).toHaveLength(1);
  });

  it('ignores a duplicate callId', () => {
    emit(request());
    emit(request());

    expect(service.requestsFor('proj-a')).toHaveLength(1);
  });

  it('stacks blocking requests; a step list is not a card', () => {
    emit(request({ callId: 'a', tool: 'confirm' }));
    emit(request({ callId: 'b', tool: 'pick' }));
    emit(todo('t1', [{ id: 's1', text: 'uno', status: 'pending' }]));

    const live = service.requestsFor('proj-a').map((r) => r.callId);
    expect(live).toEqual(['a', 'b']);
  });

  it('sends the answer and drops the card on resolve', () => {
    emit(request({ callId: 'a' }));
    service.resolve('proj-a', 'a', 'yes');

    expect(sendUiToolResult).toHaveBeenCalledWith('proj-a', 'a', 'yes');
    expect(service.requestsFor('proj-a')).toHaveLength(0);
  });

  it('never sends anything for a fire-and-forget card', () => {
    emit(request({ callId: 't1', tool: 'todo', expectsAnswer: false }));
    service.resolve('proj-a', 't1', 'whatever');

    expect(sendUiToolResult).not.toHaveBeenCalled();
    expect(service.requestsFor('proj-a')).toHaveLength(0);
  });

  it('resolving an unknown callId sends nothing', () => {
    service.resolve('proj-a', 'ghost', 'yes');

    expect(sendUiToolResult).not.toHaveBeenCalled();
  });

  it('clears a whole session when its pane goes away', () => {
    emit(request({ callId: 'a' }));
    emit(request({ callId: 'b', tool: 'pick' }));
    service.clear('proj-a');

    expect(service.requestsFor('proj-a')).toHaveLength(0);
    // Dropping locally can never wedge a run: the runner's blocking timeout is
    // the safety net for a call nobody answers.
    expect(sendUiToolResult).not.toHaveBeenCalled();
  });

  it('persists the step list into the thread, upserted not appended', () => {
    emit(
      request({
        callId: 't1',
        tool: 'todo',
        expectsAnswer: false,
        input: { items: [{ id: 'a', text: 'uno', status: 'pending' }] },
      }),
    );
    emit(
      request({
        callId: 't2',
        tool: 'todo',
        expectsAnswer: false,
        input: { items: [{ id: 'a', text: 'uno', status: 'done' }] },
      }),
    );

    // The tool sends the COMPLETE list every time, so two calls must leave one
    // message, not two near-identical copies.
    expect(upsertTodoMessage).toHaveBeenCalledTimes(2);
    expect(upsertTodoMessage.mock.calls[1]?.[0]).toBe('proj-a');
    expect(upsertTodoMessage.mock.calls[1]?.[1]).toEqual([
      { id: 'a', text: 'uno', status: 'done' },
    ]);
  });

  it('does not persist an empty or malformed step list', () => {
    emit(request({ callId: 't3', tool: 'todo', expectsAnswer: false, input: { items: [] } }));
    emit(request({ callId: 't4', tool: 'todo', expectsAnswer: false, input: {} }));

    expect(upsertTodoMessage).not.toHaveBeenCalled();
  });

  it('toasts a notify instead of drawing a card', () => {
    emit(request({ callId: 'n1', tool: 'notify', input: { title: 'Listo', body: 'Build OK' } }));

    expect(service.requestsFor('proj-a')).toHaveLength(0);
    expect(toastShow).toHaveBeenCalledOnce();
    expect(toastShow.mock.calls[0]?.[0]).toBe('Listo — Build OK');
  });

  it('maps the notify level onto the toast kind', () => {
    emit(request({ callId: 'n2', tool: 'notify', input: { title: 'Ojo', level: 'warn' } }));
    emit(request({ callId: 'n3', tool: 'notify', input: { title: 'Falló', level: 'error' } }));

    expect(toastShow.mock.calls[0]?.[1]).toEqual({ kind: 'warning' });
    expect(toastShow.mock.calls[1]?.[1]).toEqual({ kind: 'error' });
  });

  it('ignores a notify with no title', () => {
    emit(request({ callId: 'n4', tool: 'notify', input: { body: 'sin titulo' } }));

    expect(toastShow).not.toHaveBeenCalled();
    expect(service.requestsFor('proj-a')).toHaveLength(0);
  });

  it('drops the session key entirely once it is empty', () => {
    emit(request({ callId: 'a' }));
    service.drop('proj-a', 'a');

    expect(Object.keys(service.pendingUiRequests())).toEqual([]);
  });

  // S-28 T-339
  describe('execution state', () => {
    it('keeps the latest step list for the session', () => {
      emit(todo('t1', [{ id: 's1', text: 'uno', status: 'in_progress' }]));
      emit(todo('t2', [
        { id: 's1', text: 'uno', status: 'done' },
        { id: 's2', text: 'dos', status: 'in_progress' },
      ]));

      expect(service.executionFor('proj-a')?.steps.map((st) => st.status)).toEqual(['done', 'in_progress']);
    });

    it('files a card under the step that was current when it arrived, and notes the answer there', () => {
      emit(todo('t1', [
        { id: 's1', text: 'uno', status: 'done' },
        { id: 's2', text: 'dos', status: 'in_progress' },
      ]));
      emit(request({ callId: 'c1' }));

      expect(service.requestsFor('proj-a')[0]?.stepId).toBe('s2');
      service.resolve('proj-a', 'c1', 'yes', { kind: 'confirmed', detail: 'rm -rf dist' });

      expect(service.executionFor('proj-a')?.notes['s2']).toEqual([{ kind: 'confirmed', detail: 'rm -rf dist' }]);
    });

    it('a card with no plan running carries no step and leaves no note', () => {
      emit(request({ callId: 'c1' }));
      service.resolve('proj-a', 'c1', 'yes', { kind: 'confirmed', detail: 'x' });

      expect(service.requestsFor('proj-a')).toHaveLength(0);
      expect(service.executionFor('proj-a')).toBeNull();
    });

    it('approve-and-run seeds the steps at once and they survive the planning run ending', () => {
      emit(request({ callId: 'p1', tool: 'plan_approve', input: PLAN_INPUT }));
      service.resolvePlan('proj-a', 'p1', { decision: 'approve_and_run' });

      expect(service.executionFor('proj-a')?.steps).toEqual([
        { id: 'step-1', text: 'uno', status: 'in_progress' },
        { id: 'step-2', text: 'dos', status: 'pending' },
      ]);
      service.clear('proj-a'); // the planning run ends
      expect(service.executionFor('proj-a')?.steps).toHaveLength(2);
      service.clear('proj-a'); // the follow-up run ends
      expect(service.executionFor('proj-a')).toBeNull();
    });

    it('a plain approve does not seed a stepper', () => {
      emit(request({ callId: 'p1', tool: 'plan_approve', input: PLAN_INPUT }));
      service.resolvePlan('proj-a', 'p1', { decision: 'approve' });

      expect(service.executionFor('proj-a')).toBeNull();
    });

    it('the agent\'s own list replaces the seed and no longer carries over', () => {
      emit(request({ callId: 'p1', tool: 'plan_approve', input: PLAN_INPUT }));
      service.resolvePlan('proj-a', 'p1', { decision: 'approve_and_run' });
      emit(todo('t1', [{ id: 'step-1', text: 'uno', status: 'done' }]));

      expect(service.executionFor('proj-a')?.carryOver).toBe(false);
      service.clear('proj-a');
      expect(service.executionFor('proj-a')).toBeNull();
    });
  });

  // S-32 T-369
  describe('send_file', () => {
    const FILE = {
      path: '/repo/README.md',
      name: 'README.md',
      size: 1200,
      mime: 'text/markdown',
      kind: 'document',
      source: 'tool',
    };

    function sendFile(callId: string, input: unknown = FILE): UiToolRequestEvent {
      return request({ callId, tool: 'send_file', expectsAnswer: false, input });
    }

    it('adds the file to the thread as an outbox card for Telegram, and nothing to the panel', () => {
      emit(sendFile('f1'));

      expect(addMessage).toHaveBeenCalledTimes(1);
      expect(addMessage).toHaveBeenCalledWith('proj-a', {
        id: 'outbox-f1',
        role: 'outbox',
        name: 'README.md',
        kind: 'file',
        path: '/repo/README.md',
        channel: 'telegram',
      });
      expect(service.requestsFor('proj-a')).toEqual([]);
      expect(service.executionFor('proj-a')).toBeNull();
      expect(sendUiToolResult).not.toHaveBeenCalled();
    });

    it('adds one message even when the same call arrives twice', () => {
      emit(sendFile('f1'));
      emit(sendFile('f1'));

      expect(addMessage).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['photo', 'image'],
      ['video', 'video'],
      ['audio', 'file'],
      ['document', 'file'],
    ])('maps a %s to the %s card', (kind, expected) => {
      emit(sendFile('f-' + kind, { ...FILE, kind }));

      expect(addMessage.mock.calls[0]?.[1]).toMatchObject({ kind: expected });
    });

    it('goes to the session that owns the run', () => {
      emit({ ...sendFile('f1'), project: 'pane-2' });

      expect(addMessage).toHaveBeenCalledWith('pane-2', expect.objectContaining({ role: 'outbox' }));
    });

    it('ignores a payload without a path', () => {
      emit(sendFile('f1', { name: 'x' }));

      expect(addMessage).not.toHaveBeenCalled();
    });
  });
});
