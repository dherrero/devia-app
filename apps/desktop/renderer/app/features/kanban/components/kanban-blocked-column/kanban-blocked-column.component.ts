import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { IconComponent, TooltipDirective } from '@devia/ui';
import {
  LucideHelpCircle, LucideInbox, LucideLink, LucideMessageSquare, LucideUsers,
} from '@lucide/angular';

import {
  cardPriority as readCardPriority,
  priorityLabel as readPriorityLabel,
  type KanbanPriority,
} from '../../utils/kanban-filters';
import type { BlockReason, KanbanCardView } from '../../../../../types/devia';

const BLOCK_REASONS: BlockReason[] = ['dependency', 'user', 'subagent'];

/**
 * The blocked lane of the kanban board: display-only (no drag-drop), split
 * into three sub-lanes by block reason (dependency / user / sub-agent).
 * Blocked cards render their own reduced card body (reason-tinted border,
 * no dependency/sub-agent/commit badges) — unblocking happens from the
 * ticket detail, so a click only bubbles `cardOpened`.
 */
@Component({
  selector: 'ds-kanban-blocked-column',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TooltipDirective, TranslateModule],
  templateUrl: './kanban-blocked-column.component.html',
  styleUrl: './kanban-blocked-column.component.scss',
  host: { class: 'dsk-col dsk-col-blocked' },
})
export class KanbanBlockedColumnComponent {
  readonly LucideInbox = LucideInbox;
  readonly LucideMessageSquare = LucideMessageSquare;

  readonly blockReasons = BLOCK_REASONS;

  readonly cards = input.required<KanbanCardView[]>();
  readonly specTitles = input.required<Record<string, string | undefined>>();
  readonly showSpecTag = input.required<boolean>();

  readonly cardOpened = output<KanbanCardView>();

  blockedBy(reason: BlockReason): KanbanCardView[] {
    return this.cards().filter((c) => c.blockReason === reason);
  }

  reasonIcon(reason: BlockReason): typeof LucideHelpCircle | typeof LucideUsers | typeof LucideLink {
    if (reason === 'user') return LucideHelpCircle;
    if (reason === 'subagent') return LucideUsers;
    return LucideLink;
  }

  cardPriority(card: KanbanCardView): KanbanPriority {
    return readCardPriority(card);
  }

  priorityLabel(priority: KanbanPriority): string {
    return readPriorityLabel(priority);
  }
}
