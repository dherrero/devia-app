import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, IconComponent, TooltipDirective } from '@devia/ui';
import { LucideSearch, LucideX } from '@lucide/angular';

const DEFAULT_DEBOUNCE_MS = 180;

/**
 * Subatomic search box (HT-SB-03).
 *
 * - `value` (two-way model) — keeps the input in sync with the parent
 *   immediately on every keystroke; the clear button display depends on
 *   it being current.
 * - `queryChange` (debounced output) — fires after the configured quiet
 *   window with the trimmed payload. The default 180 ms matches the
 *   spec PART-02 sub-2.2 contract. Empty / whitespace-only payloads
 *   propagate immediately so callers can clear results without waiting.
 * - `cleared` — fires when the user clicks the clear button (synthesis
 *   of an empty `queryChange`, but also useful when the parent needs to
 *   reset side state like navigation history).
 *
 * Internally owned debounce: a single `setTimeout` is rescheduled on
 * every value change and torn down via `DestroyRef.onDestroy()`. Pure
 * Angular signals + native timer — no RxJS dependency added.
 *
 * The component is presentational: it does not touch `localStorage`, IPC
 * or any service. Consumers like `SidebarSearchService` listen to
 * `queryChange` to start the actual workspace search.
 */
@Component({
  selector: 'ds-search-box',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonComponent, IconComponent, TooltipDirective],
  templateUrl: './search-box.component.html',
  styleUrl: './search-box.component.scss',
  host: { class: 'ds-search-box' },
})
export class SearchBoxComponent {
  readonly value = model<string>('');
  readonly placeholder = input<string>('');
  readonly clearTooltip = input<string>('Clear');
  readonly clearAriaLabel = input<string>('Clear');
  readonly debounceMs = input<number>(DEFAULT_DEBOUNCE_MS);

  readonly queryChange = output<string>();
  readonly cleared = output<void>();

  /** Read-only flag the parent can use to mirror the empty / non-empty
   *  state without re-deriving it (used by the sidebar's `dsm-back`). */
  readonly isEmpty = computed(() => !this.value().trim());

  protected readonly LucideSearch = LucideSearch;
  protected readonly LucideX = LucideX;

  private readonly destroyRef = inject(DestroyRef);
  private readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('inputEl');

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last value we emitted via `queryChange`. Prevents back-to-back
   *  duplicate emissions when the user pauses, types the same character,
   *  pauses again. Improves DX without breaking semantics. */
  private lastEmitted = '';

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
    });
  }

  protected onInput(): void {
    const raw = this.value();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Empty / whitespace propagates immediately so the parent can clear
    // results without waiting another 180 ms after the user already saw
    // the input emptied visually.
    if (!raw.trim()) {
      if (this.lastEmitted !== '') {
        this.lastEmitted = '';
        this.queryChange.emit('');
      }
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const trimmed = raw.trim();
      if (trimmed === this.lastEmitted) return;
      this.lastEmitted = trimmed;
      this.queryChange.emit(trimmed);
    }, this.debounceMs());
  }

  protected onClear(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.value.set('');
    if (this.lastEmitted !== '') {
      this.lastEmitted = '';
      this.queryChange.emit('');
    }
    this.cleared.emit();
    // Restore focus on the input so the user can keep typing — matches
    // the VS Code search-box affordance.
    this.inputEl()?.nativeElement.focus();
  }

  /** Imperative focus hook for parents that need to programmatically
   *  highlight the box (e.g. on a global Ctrl+F binding in the future). */
  focus(): void {
    this.inputEl()?.nativeElement.focus();
  }
}
