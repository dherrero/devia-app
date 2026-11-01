import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../../../../../../shared/domain/chat';
import type { PlanRecord } from '../../../../../../../shared/domain/ui-tools';
import { PlanMessageComponent } from './plan-message.component';

function message(over: Partial<PlanRecord> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'system',
    kind: 'plan',
    text: 'Plan aprobado: Refactor',
    plan: {
      title: 'Refactor',
      plan: '**cuerpo** del plan',
      steps: [
        { id: 'step-1', text: 'uno' },
        { id: 'step-2', text: 'dos' },
      ],
      decision: 'approve_and_run',
      decidedAt: 1,
      ...over,
    },
  };
}

function mount(msg: ChatMessage): HTMLElement {
  const fixture = TestBed.createComponent(PlanMessageComponent);
  fixture.componentRef.setInput('msg', msg);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('PlanMessageComponent (S-28 T-337)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [PlanMessageComponent, TranslateModule.forRoot()] });
  });

  it('shows the verdict and title collapsed, with no action buttons', () => {
    const el = mount(message());

    expect(el.textContent).toContain('ui_tools.plan.decided_approved');
    expect(el.textContent).toContain('Refactor');
    expect(el.querySelector('.ds-plan-msg__steps')).toBeNull();
    // Only the expand toggle: a decided plan is history, never answerable.
    expect(el.querySelectorAll('button')).toHaveLength(1);
  });

  it('expands into the steps and the body', () => {
    const el = mount(message());
    (el.querySelector('button') as HTMLButtonElement).click();
    TestBed.tick();

    const steps = [...el.querySelectorAll('.ds-plan-msg__steps li')].map((li) => li.textContent);
    expect(steps).toEqual(['uno', 'dos']);
    expect(el.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('marks a rejection and shows its reason without expanding', () => {
    const el = mount(message({ decision: 'reject', comment: 'falta el test' }));

    expect(el.querySelector('.ds-plan-msg')?.classList).toContain('is-rejected');
    expect(el.textContent).toContain('ui_tools.plan.decided_rejected');
    expect(el.textContent).toContain('falta el test');
  });

  it('shows keep-planning as not-yet-approved, with its own label and comment', () => {
    const el = mount(message({ decision: 'keep_planning', comment: 'falta Telegram' }));

    expect(el.querySelector('.ds-plan-msg')?.classList).toContain('is-rejected');
    expect(el.textContent).toContain('ui_tools.plan.decided_keep_planning');
    expect(el.textContent).toContain('ui_tools.plan.keep_comment');
    expect(el.textContent).toContain('falta Telegram');
  });

  it('labels a yolo approval apart from a normal one', () => {
    const el = mount(message({ decision: 'approve_and_run_yolo' }));

    expect(el.querySelector('.ds-plan-msg')?.classList).not.toContain('is-rejected');
    expect(el.textContent).toContain('ui_tools.plan.decided_yolo');
  });
});
