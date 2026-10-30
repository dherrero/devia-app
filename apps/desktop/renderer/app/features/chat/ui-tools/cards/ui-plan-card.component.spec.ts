import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PlanApproveResult } from '../../../../../../shared/domain/ui-tools';
import { UiPlanCardComponent } from './ui-plan-card.component';

const PLAN = { title: 'Refactor del runner', plan: '1. Uno\n2. Dos', risks: 'Puede romper X' };

async function render(input: unknown): Promise<{
  el: HTMLElement;
  decisions: PlanApproveResult[];
  detect: () => void;
}> {
  const fixture = TestBed.createComponent(UiPlanCardComponent);
  const decisions: PlanApproveResult[] = [];
  fixture.componentRef.setInput('input', input);
  fixture.componentRef.setInput('callId', 'c1');
  fixture.componentInstance.decided.subscribe((d) => decisions.push(d));
  await fixture.whenStable();
  fixture.detectChanges();
  return {
    el: fixture.nativeElement as HTMLElement,
    decisions,
    detect: () => fixture.detectChanges(),
  };
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const match = [...el.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!match) throw new Error(`no button matching "${text}" in: ${el.textContent}`);
  return match as HTMLButtonElement;
}

describe('UiPlanCardComponent (S-25 F2.2)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiPlanCardComponent, TranslateModule.forRoot()] });
  });

  it('renders the title, the body slot and the risks', async () => {
    const { el } = await render(PLAN);

    expect(el.textContent).toContain('Refactor del runner');
    expect(el.textContent).toContain('Puede romper X');
    // The body goes through MarkdownRendererService, which reads `marked` /
    // `DOMPurify` off `globalThis`; neither is loaded in jsdom, so it takes the
    // documented plain-text fallback (UC-FIX-016) and renders nothing here.
    // Asserting the slot exists is all this environment can honestly check.
    expect(el.querySelector('.dsm-plan__body')).not.toBeNull();
  });

  it('emits approve without asking anything else', async () => {
    const { el, decisions } = await render(PLAN);
    buttonByText(el, 'approve').click();

    expect(decisions).toEqual([{ decision: 'approve' }]);
  });

  it('emits approve_and_run as a distinct decision', async () => {
    const { el, decisions } = await render(PLAN);
    buttonByText(el, 'approve_and_run').click();

    expect(decisions).toEqual([{ decision: 'approve_and_run' }]);
  });

  it('refuses to send a rejection with no reason', async () => {
    const { el, decisions, detect } = await render(PLAN);
    buttonByText(el, 'reject').click();
    detect();

    // A rejection with no reason makes the agent re-propose the same plan, so
    // the send button stays disabled until the user says why.
    expect(buttonByText(el, 'send_reject').disabled).toBe(true);
    buttonByText(el, 'send_reject').click();
    expect(decisions).toEqual([]);
  });

  it('emits the rejection with the comment once one is typed', async () => {
    const { el, decisions, detect } = await render(PLAN);
    buttonByText(el, 'reject').click();
    detect();

    const textarea = el.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '  usa signals  ';
    textarea.dispatchEvent(new Event('input'));
    detect();
    buttonByText(el, 'send_reject').click();

    expect(decisions).toEqual([{ decision: 'reject', comment: 'usa signals' }]);
  });

  it('renders nothing for a payload with no plan body', async () => {
    const { el } = await render({ title: 'solo titulo' });

    expect(el.querySelector('.dsm-plan')).toBeNull();
  });
});
