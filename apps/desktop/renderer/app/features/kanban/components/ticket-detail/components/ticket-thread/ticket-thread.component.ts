import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { IconComponent } from '@devia/ui';
import {
  LucideArrowLeftRight, LucideBlocks, LucideGitCommitHorizontal, LucideInfo,
  LucideLink, LucideUnlock, LucideUsers,
} from '@lucide/angular';

import type { KanbanTaskView, ThreadMessage } from '../../../../../../../types/devia';

/**
 * Conversation thread of a ticket: user replies, agent messages and
 * system events (block/unblock, moves, linked commits, sub-agents).
 * The host element is the `.thread-section` block of the detail panel.
 */
@Component({
  selector: 'ds-ticket-thread',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, IconComponent, TranslateModule],
  templateUrl: './ticket-thread.component.html',
  styleUrl: './ticket-thread.component.scss',
  host: {
    class: 'thread-section',
  },
})
export class TicketThreadComponent {
  readonly LucideInfo = LucideInfo;

  readonly task = input.required<KanbanTaskView>();

  messageClass(m: ThreadMessage): string {
    if (this.isQuestionMessage(m)) return 'msg-question';
    if (m.author === 'user') return 'msg-user';
    if (m.author === 'system') return 'msg-system';
    return 'msg-agent';
  }

  isQuestionMessage(m: ThreadMessage): boolean {
    const t = this.task();
    return t.column === 'blocked' && t.blockReason === 'user' && m.author === 'agent' && m.body === t.blockTarget;
  }

  timeLabel(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  }

  sysIcon(event: ThreadMessage['systemEvent']): typeof LucideBlocks | typeof LucideUnlock | typeof LucideLink | typeof LucideUsers | typeof LucideGitCommitHorizontal | typeof LucideArrowLeftRight | typeof LucideInfo {
    switch (event) {
      case 'blocked': return LucideBlocks;
      case 'unblocked': return LucideUnlock;
      case 'dep_resolved': return LucideLink;
      case 'subagent_invoked': return LucideUsers;
      case 'subagent_returned': return LucideUsers;
      case 'commit_linked': return LucideGitCommitHorizontal;
      case 'moved': return LucideArrowLeftRight;
      default: return LucideInfo;
    }
  }
}
