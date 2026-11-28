import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ButtonComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';

import { MAIN_AGENT, type AssignOption } from '../../../../../../shared/domain/cross-agent';

/** What the card hands back: the reply main parses, and a line for the step notes. */
export interface AssignDecision {
  /** `1. b\n2. a` — the same text a Telegram user would type. */
  reply: string;
  summary: string;
}

interface AssignCardInput {
  roles: string[];
  options: AssignOption[];
  mainAgentId: string;
}

/**
 * "Which agent runs which role" (S-56), asked by the agent through
 * `devia_assign_agents` in plan mode. One selector per role; the first option
 * is always the main agent (no split). The answer is the numbered text the
 * Telegram flow also uses, so main has a single parser for both channels.
 */
@Component({
  selector: 'ds-ui-assign-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, TranslateModule],
  templateUrl: './ui-assign-card.component.html',
  styleUrl: './ui-assign-card.component.scss',
})
export class UiAssignCardComponent {
  readonly input = input.required<unknown>();
  readonly decided = output<AssignDecision>();

  protected readonly MAIN = MAIN_AGENT;

  protected readonly card = computed<AssignCardInput | null>(() => {
    const value = this.input() as Partial<AssignCardInput> | null;
    if (!value || !Array.isArray(value.roles) || !Array.isArray(value.options)) return null;
    const roles = value.roles.filter((r): r is string => typeof r === 'string');
    const options = value.options.filter(
      (o): o is AssignOption => !!o && typeof o.key === 'string' && typeof o.agentId === 'string',
    );
    if (roles.length === 0 || options.length === 0) return null;
    return { roles, options, mainAgentId: typeof value.mainAgentId === 'string' ? value.mainAgentId : '' };
  });

  /** role → option key. Absent means the first option (the main agent). */
  private readonly picks = signal<Record<string, string>>({});

  protected pickOf(role: string): string {
    return this.picks()[role] ?? this.card()?.options[0]?.key ?? 'a';
  }

  protected onPick(role: string, key: string): void {
    this.picks.update((p) => ({ ...p, [role]: key }));
  }

  protected confirm(): void {
    const card = this.card();
    if (!card) return;
    const agentOf = (key: string): string => card.options.find((o) => o.key === key)?.agentId ?? MAIN_AGENT;
    const reply = card.roles.map((role, i) => `${i + 1}. ${this.pickOf(role)}`).join('\n');
    const summary = card.roles.map((role) => `${role} → ${agentOf(this.pickOf(role))}`).join('; ');
    this.decided.emit({ reply, summary });
  }
}
