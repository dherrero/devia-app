import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent } from '@devia/ui';
import { LucideGitCommitHorizontal } from '@lucide/angular';

/**
 * Linked-commit badges of a done ticket. Clicking a badge copies the
 * full SHA to the clipboard.
 */
@Component({
  selector: 'ds-ticket-commits',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  templateUrl: './ticket-commits.component.html',
  styleUrl: './ticket-commits.component.scss',
})
export class TicketCommitsComponent {
  readonly LucideGitCommitHorizontal = LucideGitCommitHorizontal;

  readonly commits = input.required<readonly string[]>();

  copyCommitSha(sha: string): void {
    void navigator.clipboard.writeText(sha);
  }
}
