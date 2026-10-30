import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { IconComponent } from '@devia/ui';
import { LucideArrowLeftRight } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import type { ChatMessage } from '../../../../../../../shared/domain/chat';
import type { SkillAgent } from '../../../../../../types/devia';
import { agentLabel } from '../../../../skills/models/skill-agents.model';
import { MarkdownRendererService } from '../../services/markdown-renderer.service';
import type { RenderedMarkdown } from '../../services/markdown-renderer.service';

/**
 * Cross-agent handoff divider (S-2 F3.2). Rendered instead of a normal bubble
 * for `msg.kind === 'handoff'`: a centred, full-width separator card naming
 * both agents, with the injected handoff summary behind a collapsible toggle.
 */
@Component({
  selector: 'ds-handoff-divider',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslateModule],
  templateUrl: './handoff-divider.component.html',
  styleUrl: './handoff-divider.component.scss',
  host: { class: 'ds-handoff-divider' },
})
export class HandoffDividerComponent {
  readonly msg = input.required<ChatMessage>();

  protected readonly LucideArrowLeftRight = LucideArrowLeftRight;

  private readonly markdown = inject(MarkdownRendererService);
  private readonly translate = inject(TranslateService);

  protected readonly expanded = signal(false);

  protected readonly fromLabel = computed(() =>
    agentLabel((this.msg().handoff?.fromAgentId ?? '') as SkillAgent),
  );
  protected readonly toLabel = computed(() =>
    agentLabel((this.msg().handoff?.toAgentId ?? '') as SkillAgent),
  );

  protected readonly ariaLabel = computed(() =>
    this.translate.instant('chat.handoff_title', {
      from: this.fromLabel(),
      to: this.toLabel(),
    }) as string,
  );

  protected readonly summaryHtml = computed<RenderedMarkdown>(() =>
    this.markdown.render(`handoff-${this.msg().id}`, this.msg().text ?? ''),
  );

  protected toggle(): void {
    this.expanded.update((v) => !v);
  }
}
