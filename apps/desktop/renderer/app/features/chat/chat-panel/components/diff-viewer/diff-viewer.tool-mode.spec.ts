/**
 * S-25 F2.3 — `devia_request_review`: the diff viewer in TOOL MODE.
 *
 * The behaviour that actually matters here is that the SAME `buildReviewPrompt`
 * output goes to a different destination depending on who asked for the review:
 * the composer when the user opened Cambios themselves, the blocked agent when
 * `devia_request_review` did. Getting that wrong strands a run.
 *
 * Drives the component's public `onSend` / `onCancel` rather than clicking
 * buttons: the review bar is behind i18n keys that resolve to raw paths in this
 * environment, and the routing is what is under test, not the markup.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewComment } from '../../../../../../../shared/domain/review-comment';
import { AppStateService } from '../../../../../core/services/app-state.service';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { ToastService } from '../../../../../core/services/toast.service';
import { DiffViewerComponent } from './diff-viewer.component';

const PROJECT = '/ws/proj-a';

function file(pathName: string) {
  return {
    path: pathName,
    status: 'modified',
    additions: 1,
    deletions: 0,
    lines: [{ type: 'add', content: 'x', newLineNo: 1 }],
  };
}

// No `as ReviewComment` cast on purpose: the first version of this fixture used
// `file` instead of `filePath` and the cast hid it, so the failure surfaced as
// an undefined `.replace` deep inside `buildReviewPrompt` instead of a type
// error right here.
function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    filePath: '/ws/proj-a/src/a.ts',
    line: 12,
    side: 'new',
    lineText: 'const x = 1;',
    text: 'cambia esto',
    ...over,
  };
}

const getGitDiff = vi.fn();
const setComposerDraft = vi.fn();
const clearReviewComments = vi.fn();
const reconcileReviewComments = vi.fn(() => 0);
const getReviewComments = vi.fn<() => ReviewComment[]>(() => []);
const toastShow = vi.fn();

function mockState() {
  return {
    config: signal({}),
    focusedDiffFile: signal<string | null>(null),
    getReviewComments,
    reconcileReviewComments,
    clearReviewComments,
    setComposerDraft,
    reviewCommentCount: () => getReviewComments().length,
    upsertReviewComment: vi.fn(),
    removeReviewComment: vi.fn(),
  };
}

async function mount(inputs: {
  toolMode?: boolean;
  limitToPaths?: readonly string[];
}): Promise<{
  comp: DiffViewerComponent;
  resolved: (string | null)[];
  empties: number[];
  fixture: ComponentFixture<DiffViewerComponent>;
}> {
  const fixture = TestBed.createComponent(DiffViewerComponent);
  const resolved: (string | null)[] = [];
  fixture.componentRef.setInput('project', PROJECT);
  fixture.componentRef.setInput('commentable', true);
  fixture.componentRef.setInput('toolMode', inputs.toolMode ?? false);
  fixture.componentRef.setInput('limitToPaths', inputs.limitToPaths ?? []);
  fixture.componentInstance.reviewResolved.subscribe((v) => resolved.push(v));
  const empties: number[] = [];
  fixture.componentInstance.nothingToReview.subscribe(() => empties.push(1));
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { comp: fixture.componentInstance, resolved, empties, fixture };
}

describe('DiffViewerComponent — tool mode (devia_request_review)', () => {
  beforeEach(() => {
    getGitDiff.mockReset().mockResolvedValue({ hasChanges: true, files: [file('src/a.ts')] });
    setComposerDraft.mockClear();
    clearReviewComments.mockClear();
    reconcileReviewComments.mockClear().mockReturnValue(0);
    getReviewComments.mockClear().mockReturnValue([]);
    toastShow.mockClear();

    TestBed.configureTestingModule({
      imports: [DiffViewerComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ElectronApiService, useValue: { getGitDiff } },
        { provide: AppStateService, useValue: mockState() },
        { provide: ToastService, useValue: { show: toastShow } },
      ],
    });
  });

  describe('where the review text goes', () => {
    it('emits the prompt to the agent and does NOT touch the composer', async () => {
      getReviewComments.mockReturnValue([comment()]);
      const { comp, resolved } = await mount({ toolMode: true });

      comp.onSend();

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toContain('cambia esto');
      // The agent is blocked waiting for this as its tool result. Parking it in
      // the composer would strand the run.
      expect(setComposerDraft).not.toHaveBeenCalled();
    });

    it('outside tool mode it still writes to the composer and emits nothing', async () => {
      getReviewComments.mockReturnValue([comment()]);
      const { comp, resolved } = await mount({ toolMode: false });

      comp.onSend();

      expect(setComposerDraft).toHaveBeenCalledOnce();
      expect(setComposerDraft.mock.calls[0]?.[1]).toContain('cambia esto');
      expect(resolved).toEqual([]);
    });

    it('clears the comments either way, so the next review starts clean', async () => {
      getReviewComments.mockReturnValue([comment()]);
      const { comp } = await mount({ toolMode: true });

      comp.onSend();

      expect(clearReviewComments).toHaveBeenCalledWith(PROJECT);
    });

    it('prunes stale anchors BEFORE building the prompt', async () => {
      getReviewComments.mockReturnValue([comment()]);
      const { comp } = await mount({ toolMode: true });

      comp.onSend();

      // A line number that no longer resolves reaching the agent is worse than
      // no comment at all.
      expect(reconcileReviewComments).toHaveBeenCalled();
    });

    it('refuses to send when reconciliation left no valid comment', async () => {
      getReviewComments.mockReturnValue([]);
      const { comp, resolved } = await mount({ toolMode: true });

      comp.onSend();

      expect(resolved).toEqual([]);
      expect(setComposerDraft).not.toHaveBeenCalled();
      expect(toastShow).toHaveBeenCalledOnce();
    });
  });

  describe('walking away', () => {
    it('resolves the tool with null — a cancelled review is neutral, not an error', async () => {
      const { comp, resolved } = await mount({ toolMode: true });

      comp.onCancel();

      expect(resolved).toEqual([null]);
      expect(clearReviewComments).toHaveBeenCalledWith(PROJECT);
    });

    it('outside tool mode cancelling emits nothing at all', async () => {
      const { comp, resolved } = await mount({ toolMode: false });

      comp.onCancel();

      expect(resolved).toEqual([]);
    });
  });

  describe('limitToPaths', () => {
    it('narrows the shown files to the ones the tool asked for', async () => {
      getGitDiff.mockResolvedValue({
        hasChanges: true,
        files: [file('src/a.ts'), file('src/b.ts'), file('docs/c.md')],
      });
      const { comp } = await mount({ toolMode: true, limitToPaths: ['src/a.ts'] });

      expect(comp.diff()?.files.map((f) => f.path)).toEqual(['src/a.ts']);
    });

    it('matches a bare filename and a directory prefix', async () => {
      getGitDiff.mockResolvedValue({
        hasChanges: true,
        files: [file('src/a.ts'), file('src/nested/b.ts'), file('docs/c.md')],
      });
      const { comp } = await mount({ toolMode: true, limitToPaths: ['a.ts', 'src/nested'] });

      expect(comp.diff()?.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/nested/b.ts']);
    });

    it('shows everything when the paths match nothing', async () => {
      getGitDiff.mockResolvedValue({
        hasChanges: true,
        files: [file('src/a.ts'), file('src/b.ts')],
      });
      // The agent may have named a file it only PLANNED to touch. A blank
      // review would be worse than showing the lot.
      const { comp } = await mount({ toolMode: true, limitToPaths: ['ghost.ts'] });

      expect(comp.diff()?.files).toHaveLength(2);
    });

    it('shows everything when no paths were requested', async () => {
      getGitDiff.mockResolvedValue({
        hasChanges: true,
        files: [file('src/a.ts'), file('src/b.ts')],
      });
      const { comp } = await mount({ toolMode: true });

      expect(comp.diff()?.files).toHaveLength(2);
    });
  });

  // S-28 T-335: the action bar only exists for a non-empty diff, so an empty one
  // used to leave the agent waiting for its timeout.
  describe('nothing to review', () => {
    it('signals it once when the diff is empty in tool mode', async () => {
      getGitDiff.mockResolvedValue({ hasChanges: false, files: [] });
      const { empties, resolved } = await mount({ toolMode: true });

      expect(empties).toHaveLength(1);
      expect(resolved).toEqual([]);
    });

    it('signals it when the diff cannot be read', async () => {
      getGitDiff.mockRejectedValue(new Error('boom'));
      const { empties } = await mount({ toolMode: true });

      expect(empties).toHaveLength(1);
    });

    it('stays quiet outside tool mode', async () => {
      getGitDiff.mockResolvedValue({ hasChanges: false, files: [] });
      const { empties } = await mount({ toolMode: false });

      expect(empties).toEqual([]);
    });

    it('stays quiet when there is something to review', async () => {
      const { empties } = await mount({ toolMode: true });

      expect(empties).toEqual([]);
    });
  });
});
