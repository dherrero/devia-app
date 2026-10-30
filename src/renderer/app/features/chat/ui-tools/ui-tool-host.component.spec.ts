import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UiToolRequestEvent } from '../../../../../shared/contracts/events';
import { AppStateService } from '../../../core/services/app-state.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { UiToolHostComponent, type UiFollowUpRun } from './ui-tool-host.component';
import { UiToolsService } from './ui-tools.service';

let emit: (e: UiToolRequestEvent) => void = () => undefined;
const sendUiToolResult = vi.fn();
const appendPlanMessage = vi.fn();

const PLAN = { title: 'Refactor', plan: '1. Uno', filesTouched: ['a.ts'] };

function planRequest(): UiToolRequestEvent {
  return {
    project: 'proj-a',
    callId: 'p1',
    tool: 'plan_approve',
    input: PLAN,
    expectsAnswer: true,
  };
}

async function mount(): Promise<{
  el: HTMLElement;
  followUps: UiFollowUpRun[];
  detect: () => void;
}> {
  const fixture = TestBed.createComponent(UiToolHostComponent);
  const followUps: UiFollowUpRun[] = [];
  fixture.componentRef.setInput('sessionKey', 'proj-a');
  fixture.componentInstance.followUp.subscribe((f) => followUps.push(f));
  await fixture.whenStable();
  fixture.detectChanges();
  return {
    el: fixture.nativeElement as HTMLElement,
    followUps,
    detect: () => fixture.detectChanges(),
  };
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const match = [...el.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!match) throw new Error(`no button matching "${text}"`);
  return match as HTMLButtonElement;
}

describe('UiToolHostComponent (S-25 F2.0/F2.2)', () => {
  beforeEach(() => {
    sendUiToolResult.mockClear();
    appendPlanMessage.mockClear();
    TestBed.configureTestingModule({
      imports: [UiToolHostComponent, TranslateModule.forRoot()],
      providers: [
        UiToolsService,
        {
          provide: AppStateService,
          useValue: {
            appendPlanMessage,
            upsertTodoMessage: vi.fn(),
            runningPaths: signal<ReadonlySet<string>>(new Set()),
          },
        },
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
    TestBed.inject(UiToolsService);
  });

  it('renders nothing when the pane has no live request', async () => {
    const { el } = await mount();
    expect(el.querySelector('.dsm-ui-tools')).toBeNull();
  });

  it('only renders requests belonging to its own session', async () => {
    const { el, detect } = await mount();
    emit({ ...planRequest(), project: 'other-pane' });
    detect();

    expect(el.querySelector('ds-ui-plan-card')).toBeNull();
  });

  it('resolves the tool with the rendered decision text', async () => {
    const { el, detect } = await mount();
    emit(planRequest());
    detect();
    buttonByText(el, 'approve').click();

    expect(sendUiToolResult).toHaveBeenCalledOnce();
    const [, callId, answer] = sendUiToolResult.mock.calls[0] as [string, string, string];
    expect(callId).toBe('p1');
    expect(answer).toContain('APPROVED');
  });

  it('emits no follow-up on a plain approve', async () => {
    const { el, followUps, detect } = await mount();
    emit(planRequest());
    detect();
    buttonByText(el, 'approve').click();

    expect(followUps).toEqual([]);
  });

  it('on approve-and-run it resolves FIRST and then asks for the follow-up run', async () => {
    const { el, followUps, detect } = await mount();
    emit(planRequest());
    detect();
    buttonByText(el, 'approve_and_run').click();

    // Order matters: the agent is blocked on the tool, and the queued follow-up
    // can only dispatch once its turn ends.
    expect(sendUiToolResult).toHaveBeenCalledOnce();
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.mode).toBe('apply');
    // The plan travels inlined, so the next run does not depend on the agent
    // remembering what it proposed.
    expect(followUps[0]?.prompt).toContain('1. Uno');
    expect(followUps[0]?.prompt).toContain('a.ts');
    expect(followUps[0]?.displayText).toContain('Refactor');
  });

  it('tells the agent to end its turn rather than to keep editing', async () => {
    const { el, detect } = await mount();
    emit(planRequest());
    detect();
    buttonByText(el, 'approve_and_run').click();

    const answer = (sendUiToolResult.mock.calls[0] as [string, string, string])[2];
    expect(answer).toContain('End your turn');
  });

  it('drops the card once resolved', async () => {
    const { el, detect } = await mount();
    emit(planRequest());
    detect();
    buttonByText(el, 'approve').click();
    detect();

    expect(el.querySelector('ds-ui-plan-card')).toBeNull();
  });

  // S-28 T-337
  describe('the decided plan stays in the thread', () => {
    it('records an approval with the proposed plan', async () => {
      const { el, detect } = await mount();
      emit(planRequest());
      detect();
      buttonByText(el, 'approve').click();

      expect(appendPlanMessage).toHaveBeenCalledOnce();
      const [key, record] = appendPlanMessage.mock.calls[0] as [string, Record<string, unknown>];
      expect(key).toBe('proj-a');
      expect(record).toMatchObject({ title: 'Refactor', plan: '1. Uno', decision: 'approve' });
    });

    it('records it BEFORE asking for the follow-up, so the thread reads in order', async () => {
      const order: string[] = [];
      appendPlanMessage.mockImplementation(() => order.push('plan'));
      const fixture = await mount();
      fixture.followUps.push = ((f: UiFollowUpRun) => {
        order.push('follow-up');
        return Array.prototype.push.call(fixture.followUps, f);
      }) as typeof fixture.followUps.push;
      emit(planRequest());
      fixture.detect();
      buttonByText(fixture.el, 'approve_and_run').click();

      expect(order).toEqual(['plan', 'follow-up']);
    });

    it('records a rejection with its reason', async () => {
      const { el, detect } = await mount();
      emit(planRequest());
      detect();
      buttonByText(el, 'ui_tools.plan.reject').click();
      detect();
      const textarea = el.querySelector('textarea') as HTMLTextAreaElement;
      textarea.value = 'falta el test';
      textarea.dispatchEvent(new Event('input'));
      detect();
      buttonByText(el, 'send_reject').click();

      const record = appendPlanMessage.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(record).toMatchObject({ decision: 'reject', comment: 'falta el test' });
    });
  });

  // S-28 T-339
  describe('the execution panel', () => {
    function todo(items: { id: string; text: string; status: string }[], callId = 't1'): UiToolRequestEvent {
      return { project: 'proj-a', callId, tool: 'todo', input: { items }, expectsAnswer: false };
    }
    function confirm(callId = 'c1'): UiToolRequestEvent {
      return { project: 'proj-a', callId, tool: 'confirm', input: { action: 'rm -rf dist' }, expectsAnswer: true };
    }
    const STEPS = [
      { id: 's1', text: 'Uno', status: 'done' },
      { id: 's2', text: 'Dos', status: 'in_progress' },
      { id: 's3', text: 'Tres', status: 'pending' },
    ];

    it('a step list shows as a collapsed stepper, not as a card', async () => {
      const { el, detect } = await mount();
      emit(todo(STEPS));
      detect();

      expect(el.querySelector('dv-stepper')).not.toBeNull();
      expect(el.querySelector('ds-ui-todo-card')).toBeNull();
      expect(el.querySelector('.dv-stepper__list')).toBeNull();
    });

    it('a waiting plan is the only thing shown', async () => {
      const { el, detect } = await mount();
      emit(todo(STEPS));
      emit(planRequest());
      detect();

      expect(el.querySelector('ds-ui-plan-card')).not.toBeNull();
      expect(el.querySelector('dv-stepper')).toBeNull();
    });

    it('opens by itself and draws the card INSIDE the current step', async () => {
      const { el, detect } = await mount();
      emit(todo(STEPS));
      detect();
      emit(confirm());
      detect();
      detect();

      const card = el.querySelector('ds-ui-confirm-card');
      expect(card).not.toBeNull();
      expect(card?.closest('.dv-stepper__step--active')?.textContent).toContain('Dos');
    });

    it('once answered, the card becomes a note on its step and the panel folds back', async () => {
      const { el, detect } = await mount();
      emit(todo(STEPS));
      detect();
      emit(confirm());
      detect();
      detect();
      buttonByText(el, 'ui_tools.confirm.yes').click();
      detect();
      detect();

      expect(el.querySelector('ds-ui-confirm-card')).toBeNull();
      expect(el.querySelector('.dv-stepper__list')).toBeNull();
      // Re-open by hand: the note is under the step it was answered in.
      (el.querySelector('.dv-stepper__toggle') as HTMLButtonElement).click();
      detect();
      const active = el.querySelector('.dv-stepper__step--active');
      expect(active?.textContent).toContain('ui_tools.panel.note_confirmed');
    });

    it('with no plan running a card shows on its own', async () => {
      const { el, detect } = await mount();
      emit(confirm());
      detect();

      expect(el.querySelector('ds-ui-confirm-card')).not.toBeNull();
      expect(el.querySelector('dv-stepper')).toBeNull();
    });

    it('with every step done a late card still shows, outside the steps', async () => {
      const { el, detect } = await mount();
      emit(todo(STEPS.map((st) => ({ ...st, status: 'done' }))));
      detect();
      emit(confirm());
      detect();
      detect();

      const card = el.querySelector('ds-ui-confirm-card');
      expect(card).not.toBeNull();
      expect(card?.closest('.dv-stepper__step')).toBeNull();
    });
  });
});
