import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { BadgeComponent, IconComponent, TabsComponent, TooltipDirective, type TabItem } from '@devia/ui';
import { LucideTriangleAlert } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { inject } from '@angular/core';
import type { ChatView } from '../../models/chat-view.model';

/**
 * Chat panel header (HT-CH-02). Implements `DESKTOP-PART-03-CHAT-PANEL.md`
 * sub-3.1: 3-column grid `minmax(0,1fr) auto minmax(0,1fr)` carrying the
 * project name + path on the left, the segmented `Chat | Cambios` pill in
 * the centre and a "ejecutando" badge on the right.
 *
 * Stateless — the parent owns the `view` signal and the running flag; this
 * component just paints them and emits `viewChange` on tab clicks. Using
 * `dv-tabs` (HT-C-01) keeps ARIA tablist semantics and keyboard navigation
 * uniform across the app.
 */
@Component({
  selector: 'ds-chat-header',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponent, IconComponent, TabsComponent, TooltipDirective, TranslateModule],
  templateUrl: './chat-header.component.html',
  styleUrl: './chat-header.component.scss',
  host: { class: 'ds-chat-header' },
})
export class ChatHeaderComponent {
  readonly projectName = input.required<string>();
  /** Absolute workspace path — rendered in mono, truncated on overflow. */
  readonly projectPath = input.required<string>();
  readonly view = input.required<ChatView>();
  readonly running = input(false);
  /** Number of pending working-tree changes — shown as an accent badge on the
   *  "Cambios" tab. Hidden when `0`. */
  readonly changesCount = input(0);
  /** S-3 F1.1: the pane could not get its own worktree and shares files with
   *  the primary checkout — shown as a warning icon next to the name. */
  readonly unisolated = input(false);

  readonly LucideTriangleAlert = LucideTriangleAlert;

  readonly viewChange = output<ChatView>();

  /** Compact path hint shown under the name: `~/<project folder name>` — the
   *  leaf of the absolute workspace path. The full path stays reachable via
   *  the name's `title` tooltip. */
  readonly projectSubtitle = computed(() => {
    const leaf = this.projectPath().split(/[\\/]/).filter(Boolean).pop() ?? '';
    return `~/${leaf}`;
  });

  private readonly translate = inject(TranslateService);

  /** Re-evaluates when the user switches language mid-session (translate
   *  pipe doesn't trigger on language change inside `computed`, so the
   *  signal-ish dep is the active `view`). */
  readonly tabs = computed<TabItem[]>(() => {
    // Touch view() so the computed re-runs on view change too, keeping
    // the labels in sync if the parent forces a language refresh.
    this.view();
    const changes = this.changesCount();
    return [
      { id: 'chat', label: this.translate.instant('chat.tab_chat') },
      {
        id: 'changes',
        label: this.translate.instant('chat.tab_changes'),
        ...(changes > 0 ? { badge: changes } : {}),
      },
    ];
  });

  protected onTabChange(id: string | null): void {
    if (id === 'chat' || id === 'changes') this.viewChange.emit(id);
  }
}
