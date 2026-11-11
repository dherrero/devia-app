import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { IconComponent } from '@devia/ui';
import { LucideSearch, LucideX } from '@lucide/angular';

import type { GraphSearchResult } from '../../../../../../shared/domain/code-graph';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import { GraphViewStore } from '../../services/graph-view.store';
import { kindIcon } from '../../utils/kind-icon';
import { pluralKey } from '../../utils/plural';

export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MAX_RESULTS = 50;

type SearchState = 'idle' | 'searching' | 'done' | 'error';

let nextId = 0;

/**
 * Graph search (S-44 T-511): a combobox over `codeGraphSearch`. Typing is
 * debounced; Enter or a click reveals the result (expanding its ancestors)
 * through `GraphViewStore.revealNode`. Arrows move the active option, Escape
 * closes the list and then clears the text. Answers to an older text are dropped.
 */
@Component({
  selector: 'ds-cg-search',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslateModule],
  templateUrl: './graph-search.component.html',
  styleUrl: './graph-search.component.scss',
  host: { '(focusout)': 'onFocusOut($event)' },
})
export class GraphSearchComponent {
  private readonly api = inject(ElectronApiService);
  private readonly store = inject(GraphViewStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly inputRef = viewChild.required<ElementRef<HTMLInputElement>>('input');

  readonly LucideSearch = LucideSearch;
  readonly LucideX = LucideX;
  readonly kindIcon = kindIcon;
  readonly listId = `cg-search-list-${nextId++}`;

  readonly query = signal('');
  readonly results = signal<readonly GraphSearchResult[]>([]);
  readonly state = signal<SearchState>('idle');
  readonly open = signal(false);
  readonly active = signal(-1);
  /** The text the shown results answer (the input may already hold a newer one). */
  readonly answered = signal('');

  readonly expanded = computed(() => this.open() && this.results().length > 0);
  readonly activeId = computed(() => (this.expanded() && this.active() >= 0 ? this.optionId(this.active()) : null));
  readonly statusText = computed<{ key: string; params: Record<string, unknown> } | null>(() => {
    switch (this.state()) {
      case 'searching': return { key: 'codeGraph.search.searching', params: {} };
      case 'error': return { key: 'codeGraph.search.error', params: {} };
      case 'done': {
        const count = this.results().length;
        return count === 0
          ? { key: 'codeGraph.search.none', params: { query: this.answered() } }
          : { key: pluralKey('codeGraph.search.count', count), params: { count } };
      }
      default: return null;
    }
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancelTimer());
  }

  /** Mod+F lands here. */
  focus(): void {
    const input = this.inputRef().nativeElement;
    input.focus();
    input.select();
    if (this.results().length > 0) this.open.set(true);
  }

  optionId(index: number): string {
    return `${this.listId}-${index}`;
  }

  onInput(value: string): void {
    this.query.set(value);
    this.cancelTimer();
    const text = value.trim();
    if (text === '') {
      this.seq++;
      this.results.set([]);
      this.state.set('idle');
      this.active.set(-1);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(text);
    }, SEARCH_DEBOUNCE_MS);
  }

  onKeydown(event: KeyboardEvent): void {
    const count = this.results().length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (count === 0) return;
        event.preventDefault();
        if (!this.open()) {
          this.open.set(true);
          return;
        }
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const current = this.active();
        this.active.set(current < 0 ? (step === 1 ? 0 : count - 1) : (current + step + count) % count);
        return;
      }
      case 'Enter': {
        if (count === 0) return;
        event.preventDefault();
        this.choose(Math.max(0, this.active()));
        return;
      }
      case 'Escape':
        if (this.expanded()) {
          event.preventDefault();
          event.stopPropagation();
          this.open.set(false);
        } else if (this.query() !== '') {
          event.preventDefault();
          event.stopPropagation();
          this.clear();
        }
        return;
      default:
        return;
    }
  }

  choose(index: number): void {
    const result = this.results()[index];
    if (!result) return;
    this.active.set(index);
    this.open.set(false);
    void this.store.revealNode(result.node.id, result.ancestors);
  }

  clear(): void {
    const input = this.inputRef().nativeElement;
    input.value = '';
    this.onInput('');
    this.open.set(false);
    input.focus();
  }

  onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (next && this.host.nativeElement.contains(next)) return;
    this.open.set(false);
  }

  private async run(text: string): Promise<void> {
    const project = this.store.projectKey();
    if (project === null) return;
    const seq = ++this.seq;
    this.state.set('searching');
    try {
      const found = await this.api.codeGraphSearch(project, text);
      if (seq !== this.seq) return;
      this.results.set(found.slice(0, SEARCH_MAX_RESULTS));
      this.answered.set(text);
      this.active.set(-1);
      this.state.set('done');
      this.open.set(true);
    } catch {
      if (seq !== this.seq) return;
      this.results.set([]);
      this.state.set('error');
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
