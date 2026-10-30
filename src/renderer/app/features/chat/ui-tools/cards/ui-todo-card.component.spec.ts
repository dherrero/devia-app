import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TodoItem } from '../../../../../../shared/domain/ui-tools';
import { UiTodoCardComponent } from './ui-todo-card.component';

function item(text: string, status: TodoItem['status']): TodoItem {
  return { id: text, text, status };
}

async function render(input: unknown): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(UiTodoCardComponent);
  fixture.componentRef.setInput('input', input);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('UiTodoCardComponent (S-25 F2.1)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiTodoCardComponent, TranslateModule.forRoot()] });
  });

  it('renders one row per step', async () => {
    const el = await render({
      items: [item('uno', 'done'), item('dos', 'in_progress'), item('tres', 'pending')],
    });

    expect(el.querySelectorAll('.dsm-todo__item')).toHaveLength(3);
    expect(el.textContent).toContain('dos');
  });

  it('reports progress as done/total and as a percentage', async () => {
    const el = await render({ items: [item('a', 'done'), item('b', 'done'), item('c', 'pending')] });

    expect(el.querySelector('.dsm-todo__count')?.textContent?.trim()).toBe('2/3');
    expect(el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('67');
  });

  it('marks the in-progress step so the user can see where the agent is', async () => {
    const el = await render({ items: [item('a', 'done'), item('b', 'in_progress')] });

    expect(el.querySelectorAll('.is-in_progress')).toHaveLength(1);
    expect(el.querySelectorAll('.is-done')).toHaveLength(1);
  });

  it('survives an empty or malformed payload without throwing', async () => {
    for (const payload of [null, undefined, {}, { items: 'nope' }]) {
      const el = await render(payload);
      expect(el.querySelectorAll('.dsm-todo__item')).toHaveLength(0);
      expect(el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
    }
  });

  it('has no interactive control — the tool is fire-and-forget', async () => {
    const el = await render({ items: [item('a', 'pending')] });

    expect(el.querySelectorAll('button')).toHaveLength(0);
  });
});
