import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input,
  isDevMode, output, signal, viewChild,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ButtonComponent, IconComponent } from '@devia/ui';
import { LucideMessageCircle, LucidePencil, LucideTrash2 } from '@lucide/angular';
import { AppStateService } from '../../../../../core/services/app-state.service';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { ToastService } from '../../../../../core/services/toast.service';
import { toRelativePath } from '../../../../../../../shared/domain/path-display';
import {
  buildReviewPrompt, type ReviewComment, type ReviewSide,
} from '../../../../../../../shared/domain/review-comment';
import type { DiffFile, DiffLine, DiffResult } from '../../../../../../types/devia';

const STATUS_KEY: Record<string, string> = {
  added: 'diff_viewer.status_added',
  modified: 'diff_viewer.status_modified',
  deleted: 'diff_viewer.status_deleted',
  renamed: 'diff_viewer.status_renamed',
};

@Component({
  selector: 'ds-diff-viewer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './diff-viewer.component.html',
  styleUrl: './diff-viewer.component.scss',
})
export class DiffViewerComponent {
  readonly LucideMessageCircle = LucideMessageCircle;
  readonly LucidePencil = LucidePencil;
  readonly LucideTrash2 = LucideTrash2;
  private readonly api = inject(ElectronApiService);
  private readonly translate = inject(TranslateService);
  private readonly state = inject(AppStateService);
  private readonly toast = inject(ToastService);
  private readonly hostRef = inject(ElementRef<HTMLElement>);

  /**
   * Project path — used to fetch the diff via IPC.
   * Mutually exclusive with `inlineFiles`: when `inlineFiles` is provided
   * the IPC fetch is skipped entirely and `project` is not required.
   * At least one of `project` or `inlineFiles` must be provided.
   * (REV-TS-CLI-10-01)
   */
  readonly project = input<string>('');

  /**
   * Pre-fetched diff files (TS-CLI-10 inline mode). When set, the component
   * renders these directly without making an IPC call to `getGitDiff`.
   * Use this when the diff has already been computed in the main process.
   */
  readonly inlineFiles = input<DiffFile[] | undefined>(undefined);

  /**
   * Enables the line-comment UI and the review action bar (S-1). Off by
   * default so the inline tool-call usage stays a plain read-only diff.
   */
  readonly commentable = input<boolean>(false);
  /**
   * S-25 F2.3 — the review was asked for by `devia_request_review`, so the
   * comments are the RESULT OF A TOOL CALL, not a draft for the composer. The
   * text is built exactly the same way either path; only its destination
   * changes, so `buildReviewPrompt` stays the single source of truth.
   */
  readonly toolMode = input<boolean>(false);
  /** Paths the tool asked to narrow the review to. Empty means everything. */
  readonly limitToPaths = input<readonly string[]>([]);
  /** In `toolMode`: the built prompt, or null when the user reviewed nothing. */
  readonly reviewResolved = output<string | null>();
  /**
   * In `toolMode`: the diff loaded and there is nothing in it. The action bar
   * only exists for a non-empty diff, so without this the agent would wait for
   * a reply the user has no way to give (S-28 T-335).
   */
  readonly nothingToReview = output<void>();

  /** Asks the host (chat-panel) to switch back to the chat view. */
  readonly requestChatView = output<void>();

  readonly diff = signal<DiffResult | null>(null);
  readonly loading = signal(true);

  /** `${filePath}::${side}::${line}` of the line whose editor is open, or null. */
  readonly editingKey = signal<string | null>(null);
  /** Initial textarea value when opening the editor (existing text or ''). */
  readonly editorSeed = signal('');

  private readonly commentEditorRef =
    viewChild<ElementRef<HTMLTextAreaElement>>('commentEditor');

  constructor() {
    effect(() => {
      const inline = this.inlineFiles();
      if (inline !== undefined) {
        // Inline mode: render the pre-fetched diff without an IPC call.
        this.diff.set({ hasChanges: inline.length > 0, files: inline });
        this.loading.set(false);
        return;
      }
      const p = this.project();
      // REV-TS-CLI-10-01: warn in dev mode when neither source is provided.
      if (!p) {
        if (isDevMode()) {
          console.warn('[ds-diff-viewer] Either `project` or `inlineFiles` must be provided.');
        }
        return;
      }
      this.loading.set(true);
      this.api.getGitDiff(p).then((d) => {
        const result = this.narrowToRequestedPaths(d as DiffResult);
        this.diff.set(result);
        this.loading.set(false);
        // S-1: prune comments anchored to a stale snapshot (commit/stash/edit
        // happened since they were written) and tell the user how many went.
        if (this.commentable()) {
          const dropped = this.state.reconcileReviewComments(p, result);
          if (dropped > 0) {
            this.toast.show(
              this.translate.instant('diff_viewer.review_dropped', { count: dropped }),
              { kind: 'warning' },
            );
          }
        }
        if (this.toolMode() && !result.hasChanges) this.nothingToReview.emit();
      }).catch((err: unknown) => {
        console.error('[diff]', err);
        this.diff.set({ hasChanges: false, files: [] });
        this.loading.set(false);
        if (this.toolMode()) this.nothingToReview.emit();
      });
    });

    // Scroll-into-view when the file tree (or anything else) requests focus
    // on a specific file. We clear the signal after consumption so clicking
    // the same file twice re-fires this effect.
    effect(() => {
      const target = this.state.focusedDiffFile();
      const d = this.diff();
      if (!target || !d || this.loading()) return;
      queueMicrotask(() => {
        const root = this.hostRef.nativeElement;
        const el = root.querySelector(
          `article[data-path="${cssEscape(target)}"]`,
        ) as HTMLElement | null;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el.classList.add('is-focused');
          setTimeout(() => el.classList.remove('is-focused'), 1500);
        }
        this.state.focusedDiffFile.set(null);
      });
    });
  }

  readonly files = computed(() => this.diff()?.files.length ?? 0);

  readonly totalAdds = computed(() =>
    (this.diff()?.files ?? []).reduce(
      (n, f) => n + f.lines.filter((l) => l.type === 'add').length, 0,
    ),
  );

  readonly totalDels = computed(() =>
    (this.diff()?.files ?? []).reduce(
      (n, f) => n + f.lines.filter((l) => l.type === 'del').length, 0,
    ),
  );

  /** Lookup of the current project's comments keyed like `lineKey`. */
  private readonly commentMap = computed(() => {
    const map = new Map<string, ReviewComment>();
    const p = this.project();
    if (!this.commentable() || !p) return map;
    for (const c of this.state.getReviewComments(p)) {
      map.set(`${c.filePath}::${c.side}::${c.line}`, c);
    }
    return map;
  });

  readonly reviewCount = computed(() => {
    const p = this.project();
    return this.commentable() && p ? this.state.reviewCommentCount(p) : 0;
  });

  displayPath(absPath: string): string {
    return toRelativePath(absPath, this.state.config()?.workspaceRoot ?? '');
  }

  statusLabel(status: string) {
    const key = STATUS_KEY[status];
    return key ? this.translate.instant(key) : status;
  }

  markerFor(type: string): string {
    if (type === 'add') return '+';
    if (type === 'del') return '−';
    return ' ';
  }

  countAdds = (file: { lines: { type: string }[] }) =>
    file.lines.filter((l) => l.type === 'add').length;
  countDels = (file: { lines: { type: string }[] }) =>
    file.lines.filter((l) => l.type === 'del').length;

  // ── Comments ────────────────────────────────────────────────────────────
  /** Stable key for a commentable line, or null for hunk/unnumbered lines. */
  lineKey(file: DiffFile, line: DiffLine): string | null {
    if (line.type === 'hunk') return null;
    const ln = line.newLineNo ?? line.oldLineNo;
    if (ln == null) return null;
    const side: ReviewSide = line.newLineNo != null ? 'new' : 'old';
    return `${file.path}::${side}::${ln}`;
  }

  commentFor(file: DiffFile, line: DiffLine): ReviewComment | undefined {
    const k = this.lineKey(file, line);
    return k ? this.commentMap().get(k) : undefined;
  }

  onLineClick(file: DiffFile, line: DiffLine): void {
    const key = this.lineKey(file, line);
    if (!this.commentable() || !key) return;
    this.editorSeed.set(this.commentMap().get(key)?.text ?? '');
    this.editingKey.set(key);
    requestAnimationFrame(() => {
      const ta = this.commentEditorRef()?.nativeElement;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
  }

  onEditorEnter(e: Event, file: DiffFile, line: DiffLine): void {
    const ev = e as KeyboardEvent;
    if (ev.shiftKey) return;
    ev.preventDefault();
    this.saveComment(file, line);
  }

  saveComment(file: DiffFile, line: DiffLine): void {
    const p = this.project();
    const ta = this.commentEditorRef()?.nativeElement;
    const ln = line.newLineNo ?? line.oldLineNo;
    if (!p || !ta || ln == null) return;
    const side: ReviewSide = line.newLineNo != null ? 'new' : 'old';
    const text = ta.value.trim();
    if (text) {
      this.state.upsertReviewComment(p, {
        filePath: file.path, line: ln, side, lineText: line.text, text,
      });
    } else {
      // Saving an empty box clears the line's comment.
      this.state.removeReviewComment(p, file.path, ln, side);
    }
    this.editingKey.set(null);
  }

  deleteComment(file: DiffFile, line: DiffLine): void {
    const p = this.project();
    const ln = line.newLineNo ?? line.oldLineNo;
    if (!p || ln == null) return;
    const side: ReviewSide = line.newLineNo != null ? 'new' : 'old';
    this.state.removeReviewComment(p, file.path, ln, side);
    if (this.editingKey() === this.lineKey(file, line)) this.editingKey.set(null);
  }

  cancelEdit(): void {
    this.editingKey.set(null);
  }

  /**
   * S-25 F2.3 — honour the tool's `paths`, when it asked for any.
   *
   * A path that matches nothing is IGNORED rather than emptying the view: the
   * agent may have named a file it only planned to touch, and showing the user
   * a blank review would be worse than showing them everything.
   */
  private narrowToRequestedPaths(result: DiffResult): DiffResult {
    const wanted = this.limitToPaths();
    if (wanted.length === 0) return result;
    const files = result.files.filter((f) =>
      wanted.some((w) => f.path === w || f.path.endsWith(`/${w}`) || f.path.startsWith(`${w}/`)),
    );
    return files.length > 0 ? { ...result, files } : result;
  }

  // ── Review bar ────────────────────────────────────────────────────────────
  onCancel(): void {
    const p = this.project();
    if (p) this.state.clearReviewComments(p);
    // A tool-driven review the user walked away from is not an error: the
    // agent gets a neutral "no comments" and carries on.
    if (this.toolMode()) this.reviewResolved.emit(null);
    this.requestChatView.emit();
  }

  onSend(): void {
    const p = this.project();
    const d = this.diff();
    if (!p || !d) return;
    // Hard guard: never emit a reference to a line that no longer resolves.
    this.state.reconcileReviewComments(p, d);
    const comments = this.state.getReviewComments(p);
    if (comments.length === 0) {
      this.toast.show(
        this.translate.instant('diff_viewer.review_send_empty'),
        { kind: 'warning' },
      );
      return;
    }
    const text = buildReviewPrompt(comments, {
      prefix: this.translate.instant('diff_viewer.review_prefix'),
      fileLabel: this.translate.instant('diff_viewer.file_label'),
      linePrefix: this.translate.instant('diff_viewer.line_prefix'),
      commentLabel: this.translate.instant('diff_viewer.comment_label'),
    }, (fp) => this.displayPath(fp));
    // Same text, different destination. In tool mode the composer is NOT
    // touched: the agent is blocked waiting for this as its tool result, and
    // parking it in the composer would strand the run.
    if (this.toolMode()) this.reviewResolved.emit(text);
    else this.state.setComposerDraft(p, text);
    this.state.clearReviewComments(p);
    this.requestChatView.emit();
  }
}

// CSS.escape isn't typed by Angular's lib (DOM lib has it, but the type
// is sometimes absent under older TS targets). Local helper keeps the
// CSS selector quoting safe for paths with dots, slashes, etc.
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
