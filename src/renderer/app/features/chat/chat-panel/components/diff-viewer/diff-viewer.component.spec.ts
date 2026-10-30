/**
 * S-1 — Planned TestBed tests for the DiffViewerComponent comment feature.
 *
 * The comment-building, signature and reconciliation logic lives in
 * shared/domain/review-comment.ts and is fully covered by node unit tests
 * (review-comment.test.ts). These stubs document the component-level flows
 * that need a DOM runner (line click → editor, save, review bar, view switch).
 */
import { describe, it } from 'vitest';

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
