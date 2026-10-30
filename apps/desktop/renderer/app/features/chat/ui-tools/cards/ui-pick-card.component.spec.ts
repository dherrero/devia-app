import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectTreeResult } from '../../../../../../shared/domain/project-tree';
import type { PickResult } from '../../../../../../shared/domain/ui-tools';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import { UiPickCardComponent } from './ui-pick-card.component';

const TREE: Record<string, ProjectTreeResult> = {
  '': {
    subPath: '',
    children: [
      { name: 'src', path: 'src', isDir: true },
      { name: 'README.md', path: 'README.md', isDir: false },
    ],
  },
  src: {
    subPath: 'src',
    children: [{ name: 'main.ts', path: 'src/main.ts', isDir: false }],
  },
};

const listProjectTree = vi.fn(async (_p: string, sub = '') => {
  const found = TREE[sub];
  if (!found) throw new Error('ENOENT');
  return found;
});

async function render(
  input: unknown,
): Promise<{ el: HTMLElement; decisions: PickResult[]; detect: () => Promise<void> }> {
  const fixture = TestBed.createComponent(UiPickCardComponent);
  const decisions: PickResult[] = [];
  fixture.componentRef.setInput('input', input);
  fixture.componentRef.setInput('project', '/ws/proj-a');
  fixture.componentInstance.decided.subscribe((d) => decisions.push(d));
  const detect = async (): Promise<void> => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await detect();
  return { el: fixture.nativeElement as HTMLElement, decisions, detect };
}

function rowByName(el: HTMLElement, name: string): HTMLButtonElement {
  const match = [...el.querySelectorAll('.dsm-pick__pick')].find((b) =>
    (b.textContent ?? '').includes(name),
  );
  if (!match) throw new Error(`no row for "${name}" in: ${el.textContent}`);
  return match as HTMLButtonElement;
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const match = [...el.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!match) throw new Error(`no button "${text}"`);
  return match as HTMLButtonElement;
}

describe('UiPickCardComponent (S-25 F2.5)', () => {
  beforeEach(() => {
    listProjectTree.mockClear();
    TestBed.configureTestingModule({
      imports: [UiPickCardComponent, TranslateModule.forRoot()],
      providers: [{ provide: ElectronApiService, useValue: { listProjectTree } }],
    });
  });

  it('lists the project root on open', async () => {
    const { el } = await render({});

    expect(listProjectTree).toHaveBeenCalledWith('/ws/proj-a', '');
    expect(el.textContent).toContain('README.md');
    expect(el.textContent).toContain('src');
  });

  it('returns paths RELATIVE to the project — an absolute host path must never leave', async () => {
    const { el, decisions, detect } = await render({});
    rowByName(el, 'README.md').click();
    await detect();
    buttonByText(el, 'send').click();

    expect(decisions).toEqual([{ paths: ['README.md'] }]);
  });

  it('keeps one selection at a time unless multiple is set', async () => {
    const { el, decisions, detect } = await render({});
    rowByName(el, 'README.md').click();
    rowByName(el, 'src').click();
    await detect();
    buttonByText(el, 'send').click();

    expect(decisions).toEqual([{ paths: ['src'] }]);
  });

  it('accumulates when multiple is set', async () => {
    const { el, decisions, detect } = await render({ multiple: true });
    rowByName(el, 'README.md').click();
    rowByName(el, 'src').click();
    await detect();
    buttonByText(el, 'send').click();

    expect(decisions).toEqual([{ paths: ['README.md', 'src'] }]);
  });

  it('locks files when the agent asked for a directory', async () => {
    const { el } = await render({ filter: 'dir' });

    expect(rowByName(el, 'src').disabled).toBe(false);
    expect(el.textContent).not.toContain('README.md');
  });

  it('falls back to the project root when the agent invents a root', async () => {
    const { el } = await render({ root: 'does/not/exist' });

    // Degrading to the root beats leaving the card empty and unusable.
    expect(listProjectTree).toHaveBeenCalledWith('/ws/proj-a', 'does/not/exist');
    expect(el.textContent).toContain('README.md');
  });

  it('cancels with an empty selection rather than an error', async () => {
    const { el, decisions } = await render({});
    buttonByText(el, 'cancel').click();

    expect(decisions).toEqual([{ paths: [] }]);
  });

  it('cannot send an empty selection', async () => {
    const { el } = await render({});

    expect(buttonByText(el, 'send').disabled).toBe(true);
  });
});
