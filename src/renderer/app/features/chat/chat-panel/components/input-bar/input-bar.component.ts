import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, IconComponent, TooltipDirective } from '@devia/ui';
import {
  LucideArrowRight,
  LucideMic,
  LucidePaperclip,
  LucideRefreshCw,
  LucideSquare,
} from '@lucide/angular';
import { TranslateModule } from '@ngx-translate/core';
import type { VoiceState } from '../../services/voice-recorder';
import { ChatScrollService } from '../../services/chat-scroll.service';

/**
 * Composer / input bar (HT-IN-01).
 *
 * Implements `DESKTOP-PART-05-INPUT-AREA.md`:
 *
 * - 5-column grid `mic | attach | textarea | send/stop | reset`.
 * - 14 px rounded rectangle, focus-within accent ring 3 px.
 * - Textarea autosizes up to 6 lines (real line-height + padding); when
 *   the user was near the bottom of the messages feed, growing the
 *   input re-pins the scroller to the latest message via
 *   `ChatScrollService` so the freshest content stays in view.
 *
 * Composer-only — the parent still owns the WSL clipboard warning and
 * the actual send IPC. Outputs:
 * - `submit`  — Enter without Shift (the parent guards `canSend`).
 * - `stop`    — clicked while `running=true`.
 * - `reset`   — "Nueva sesión" refresh icon.
 * - `voice`   — mic button click (parent toggles recording).
 * - `paste`   — bubbled `ClipboardEvent` so the parent can extract
 *               pasted files or fire the WSL warning.
 * - `filesPicked` — files chosen through the attach (paperclip) button.
 */
@Component({
  selector: 'ds-input-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonComponent, IconComponent, TooltipDirective, TranslateModule],
  templateUrl: './input-bar.component.html',
  styleUrl: './input-bar.component.scss',
  host: { class: 'ds-input-bar' },
})
export class InputBarComponent {
  readonly draft = model.required<string>();
  readonly canSend = input(false);
  readonly running = input(false);
  readonly micState = input<VoiceState>('idle');
  readonly micTooltip = input<string>('');

  readonly submitted = output<void>();
  readonly stop = output<void>();
  readonly resetRequested = output<void>();
  readonly voice = output<void>();
  readonly pasted = output<ClipboardEvent>();
  readonly filesPicked = output<File[]>();

  protected readonly LucideArrowRight = LucideArrowRight;
  protected readonly LucideMic = LucideMic;
  protected readonly LucidePaperclip = LucidePaperclip;
  protected readonly LucideRefreshCw = LucideRefreshCw;
  protected readonly LucideSquare = LucideSquare;

  private readonly scroll = inject(ChatScrollService);
  private readonly inputEl = viewChild<ElementRef<HTMLTextAreaElement>>('inputEl');

  /** User-dragged textarea height (px). `null` = default content autosize
   *  (up to 6 lines); a number pins a taller writing area. */
  private readonly userHeightPx = signal<number | null>(null);

  constructor() {
    // Autosize on every draft change AND whenever the textarea (re)mounts
    // — toggling chat view, project switch, etc. rAF (not microtask) so
    // layout has settled and scrollHeight reflects the real content.
    // Re-runs when the user-dragged height changes too.
    effect(() => {
      void this.inputEl();
      void this.draft();
      void this.userHeightPx();
      requestAnimationFrame(() => this.autosize());
    });
  }

  /** Drag the top handle to grow the writing area beyond the default 6-line
   *  cap; dragging back to (or below) the baseline restores autosize. */
  protected startResize(event: MouseEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const ta = this.inputEl()?.nativeElement;
    if (!ta) return;
    const cs = getComputedStyle(ta);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const baseline = Math.round(lineH * 6 + padY);
    const maxH = Math.round(window.innerHeight * 0.5);
    const startY = event.clientY;
    const startH = this.userHeightPx() ?? baseline;

    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e: MouseEvent): void => {
      const next = startH + (startY - e.clientY);
      if (next <= baseline) {
        this.userHeightPx.set(null);
        this.autosize();
      } else {
        const clamped = Math.min(maxH, next);
        this.userHeightPx.set(clamped);
        ta.style.height = `${clamped}px`;
        ta.style.overflowY = 'auto';
      }
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /** Double-click the handle to reset to the default autosize behaviour. */
  protected resetHeight(): void {
    this.userHeightPx.set(null);
    this.autosize();
  }

  /** Public hook the parent can call after voice transcription or
   *  prompt-injection to put the cursor back in the input. */
  focus(): void {
    this.inputEl()?.nativeElement.focus();
  }

  /** Re-engage follow + grow the textarea on user input. */
  protected onInput(): void {
    this.scroll.reengageFollow();
    this.autosize();
  }

  protected onEnter(e: Event): void {
    const ev = e as KeyboardEvent;
    if (ev.shiftKey) return;
    ev.preventDefault();
    this.submitted.emit();
  }

  protected onFilesPicked(el: HTMLInputElement): void {
    const files = Array.from(el.files ?? []);
    // Reset so picking the same file again still fires `change`.
    el.value = '';
    if (files.length > 0) this.filesPicked.emit(files);
  }

  protected onPaste(e: ClipboardEvent): void {
    // Parent owns the WSL warning + image-paste interception. The default
    // text-paste behavior is preserved when the parent doesn't call
    // preventDefault on the bubbled event.
    this.pasted.emit(e);
  }

  /** Grow the textarea to fit its content, capped at 6 lines. The cap is
   *  computed from the real line-height + vertical padding so it scales
   *  with the type-scale knob in styles.scss. Re-pins the messages feed
   *  to the bottom if the user was already there — growing the input
   *  shrinks the messages row, which would otherwise hide the freshest
   *  message behind the bar. */
  private autosize(): void {
    const ta = this.inputEl()?.nativeElement;
    if (!ta) return;
    const wasNearBottom = this.scroll.stickToBottom();
    // User-resized: pin to the dragged height and scroll within.
    const userH = this.userHeightPx();
    if (userH !== null) {
      ta.style.height = `${userH}px`;
      ta.style.overflowY = 'auto';
      if (wasNearBottom) requestAnimationFrame(() => this.scroll.pin());
      return;
    }
    const cs = getComputedStyle(ta);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const maxH = Math.round(lineH * 6 + padY);
    ta.style.height = 'auto';
    const next = Math.min(ta.scrollHeight, maxH);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > maxH ? 'auto' : 'hidden';
    if (wasNearBottom) requestAnimationFrame(() => this.scroll.pin());
  }
}
