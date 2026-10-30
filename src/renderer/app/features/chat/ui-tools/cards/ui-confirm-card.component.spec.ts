import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ConfirmResult } from '../../../../../../shared/domain/ui-tools';
import { UiConfirmCardComponent } from './ui-confirm-card.component';

async function render(
  input: unknown,
): Promise<{ el: HTMLElement; decisions: ConfirmResult[] }> {
  const fixture = TestBed.createComponent(UiConfirmCardComponent);
  const decisions: ConfirmResult[] = [];
  fixture.componentRef.setInput('input', input);
  fixture.componentInstance.decided.subscribe((d) => decisions.push(d));
  await fixture.whenStable();
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, decisions };
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text)) as
    | HTMLButtonElement
    | undefined;
}

describe('UiConfirmCardComponent (S-25 F2.4)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiConfirmCardComponent, TranslateModule.forRoot()] });
  });

  it('shows the exact action and its detail', async () => {
    const { el } = await render({ action: 'rm -rf dist', detail: 'Limpia el build' });

    expect(el.textContent).toContain('rm -rf dist');
    expect(el.textContent).toContain('Limpia el build');
  });

  it('emits each of the three decisions', async () => {
    for (const [label, decision] of [
      ['yes', 'yes'],
      ['no', 'no'],
      ['always', 'always'],
    ] as const) {
      const { el, decisions } = await render({ action: 'x' });
      buttonByText(el, label)?.click();
      expect(decisions).toEqual([{ decision }]);
    }
  });

  it('NEVER offers "always" for an action the agent flagged as destructive', async () => {
    const { el } = await render({ action: 'rm -rf /', danger: true });

    // One careless click must not become a standing permission for the most
    // dangerous class of action.
    expect(buttonByText(el, 'always')).toBeUndefined();
    expect(buttonByText(el, 'yes')).toBeDefined();
    expect(buttonByText(el, 'no')).toBeDefined();
  });

  it('marks a destructive action visually', async () => {
    const { el } = await render({ action: 'x', danger: true });

    expect(el.querySelector('.is-danger')).not.toBeNull();
  });

  it('renders nothing without an action', async () => {
    const { el } = await render({ detail: 'sin acción' });

    expect(el.querySelector('.dsm-confirm')).toBeNull();
  });
});
