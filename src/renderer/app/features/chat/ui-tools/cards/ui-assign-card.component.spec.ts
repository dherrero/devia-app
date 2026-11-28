import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { UiAssignCardComponent, type AssignDecision } from './ui-assign-card.component';

const INPUT = {
  roles: ['implementer', 'reviewer'],
  options: [
    { key: 'a', agentId: 'main' },
    { key: 'b', agentId: 'pi' },
    { key: 'c', agentId: 'opencode' },
  ],
  mainAgentId: 'claude',
};

async function render(input: unknown): Promise<{ el: HTMLElement; decisions: AssignDecision[] }> {
  const fixture = TestBed.createComponent(UiAssignCardComponent);
  const decisions: AssignDecision[] = [];
  fixture.componentRef.setInput('input', input);
  fixture.componentInstance.decided.subscribe((d) => decisions.push(d));
  await fixture.whenStable();
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, decisions };
}

const selects = (el: HTMLElement): HTMLSelectElement[] => [...el.querySelectorAll('select')] as HTMLSelectElement[];
const confirmButton = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector('dv-button[data-assign-confirm] button') as HTMLButtonElement;

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

describe('UiAssignCardComponent (S-56 T9)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiAssignCardComponent, TranslateModule.forRoot()] });
  });

  it('draws one selector per role, with every option, defaulting to the main agent', async () => {
    const { el } = await render(INPUT);
    const boxes = selects(el);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect([...box.options].map((o) => o.value)).toEqual(['a', 'b', 'c']);
      expect(box.value).toBe('a');
    }
    expect(el.textContent).toContain('pi');
    expect(el.textContent).toContain('opencode');
  });

  it('only draws the roles it was asked about', async () => {
    const { el } = await render({ ...INPUT, roles: ['reviewer'] });
    expect(selects(el)).toHaveLength(1);
  });

  it('answers with the reply text the main process parses, and a readable summary', async () => {
    const { el, decisions } = await render(INPUT);
    const [implementer, reviewer] = selects(el);
    choose(implementer as HTMLSelectElement, 'b');
    choose(reviewer as HTMLSelectElement, 'c');
    confirmButton(el).click();

    expect(decisions).toEqual([{ reply: '1. b\n2. c', summary: 'implementer → pi; reviewer → opencode' }]);
  });

  it('keeping everything with the main agent is a valid answer', async () => {
    const { el, decisions } = await render(INPUT);
    confirmButton(el).click();
    expect(decisions).toEqual([{ reply: '1. a\n2. a', summary: 'implementer → main; reviewer → main' }]);
  });

  it('numbers the lines by the position of the role in THIS question', async () => {
    const { el, decisions } = await render({ ...INPUT, roles: ['reviewer'] });
    choose(selects(el)[0] as HTMLSelectElement, 'b');
    confirmButton(el).click();
    expect(decisions).toEqual([{ reply: '1. b', summary: 'reviewer → pi' }]);
  });

  it('draws nothing for an unusable payload', async () => {
    for (const bad of [null, undefined, {}, { roles: [], options: [] }, 'x']) {
      const { el } = await render(bad);
      expect(selects(el)).toHaveLength(0);
    }
  });
});
