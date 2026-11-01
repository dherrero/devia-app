/**
 * S-1 — Planned TestBed tests for the DiffViewerComponent comment feature.
 *
 * The comment-building, signature and reconciliation logic lives in
 * shared/domain/review-comment.ts and is fully covered by node unit tests
 * (review-comment.test.ts). These stubs document the component-level flows
 * that need a DOM runner (line click → editor, save, review bar, view switch).
 */
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppStateService } from '../../../../../core/services/app-state.service';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { ToastService } from '../../../../../core/services/toast.service';
import { DiffViewerComponent } from './diff-viewer.component';

describe('DiffViewerComponent — comments (commentable mode)', () => {
  it.todo('clicking a non-hunk line opens the inline editor seeded with any existing text');
  it.todo('clicking a hunk line is a no-op');
  it.todo('Save with text upserts a ReviewComment anchored to newLineNo (side "new")');
  it.todo('Save on a deleted line anchors to oldLineNo (side "old")');
  it.todo('Saving an empty editor removes the line comment');
  it.todo('delete action removes the comment and closes the editor if open');
  it.todo('a commented line shows the .has-comment gutter accent and the saved bubble');
  it.todo('reviewCount() reflects the current project comment count');
});

describe('DiffViewerComponent — review bar', () => {
  it.todo('the bar is hidden when commentable is false (inline tool-call usage)');
  it.todo('"Enviar a revisar" is disabled with zero comments');
  it.todo('Cancelar clears the comments and emits requestChatView without touching the composer');
  it.todo('Enviar a revisar builds the prompt, calls setComposerDraft, clears and emits requestChatView');
  it.todo('Enviar a revisar aborts with a toast when reconciliation leaves no valid comments');
  it.todo('a fetch that drops stale comments shows the review_dropped toast');
});

// S-25 F2.3 (tool mode) is covered for real in `diff-viewer.tool-mode.spec.ts`:
// where the review text goes, cancelling, and `limitToPaths`. The routing of the
// result back to the blocked agent lives in `chat-panel.request-review.spec.ts`.

describe('DiffViewerComponent — collapsible file blocks', () => {
  const mkFile = (path: string) => ({
    path,
    status: 'modified',
    lines: [{ type: 'add', text: 'x', newLineNo: 1 }],
  });

  async function mount() {
    TestBed.configureTestingModule({
      imports: [DiffViewerComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ElectronApiService, useValue: { getGitDiff: vi.fn() } },
        { provide: AppStateService, useValue: { config: signal({}), focusedDiffFile: signal(null) } },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(DiffViewerComponent);
    fixture.componentRef.setInput('inlineFiles', [mkFile('a.ts'), mkFile('b.ts')]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const articles = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>('article.dsm-diff-file'));

  beforeEach(() => TestBed.resetTestingModule());

  it('starts with every file expanded', async () => {
    const f = await mount();
    expect(articles(f.nativeElement).every((a) => a.querySelector('.dsm-diff-body'))).toBe(true);
  });

  it('toggling hides only that file body and flips aria-expanded', async () => {
    const f = await mount();
    const [a, b] = articles(f.nativeElement);
    const btn = a!.querySelector<HTMLElement>('.dsm-diff-toggle')!;
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    f.componentInstance.toggleCollapsed('a.ts');
    f.detectChanges();

    expect(a!.querySelector('.dsm-diff-body')).toBeNull();
    expect(b!.querySelector('.dsm-diff-body')).not.toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    f.componentInstance.toggleCollapsed('a.ts');
    f.detectChanges();
    expect(a!.querySelector('.dsm-diff-body')).not.toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });
});
