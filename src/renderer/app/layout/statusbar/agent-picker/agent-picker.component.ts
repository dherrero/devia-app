import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { DialogRef, IconComponent } from '@devia/ui';
import { LucideBot, LucideCheck, LucideSettings2 } from '@lucide/angular';
import { AppStateService } from '../../../core/services/app-state.service';
import { AgentSwitchHandoffService } from '../../../core/services/agent-switch-handoff.service';
import { ToastService } from '../../../core/services/toast.service';
import { KeyboardShortcutsService } from '../../../core/layout/keyboard-shortcuts.service';
import type { DetectedAgentView } from '../../../../../shared/domain/agent';

export interface AgentPickerItem {
  id: string;
  name: string;
  current: boolean;
}

/** Agents the user can run an instruction with: installed AND selectable. Pure, so it is testable on its own. */
export function buildAgentPickerItems(
  agents: readonly DetectedAgentView[],
  currentAgentId: string,
): AgentPickerItem[] {
  return agents
    .filter((a) => a.available && a.selectable !== false)
    .map((a) => ({ id: a.id, name: a.name, current: a.id === currentAgentId }));
}

/**
 * Footer agent picker (S-53). Chooses the agent of the SELECTED PROJECT; the
 * global default is still chosen in Settings › Execution.
 */
@Component({
  selector: 'ds-agent-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslateModule],
  templateUrl: './agent-picker.component.html',
  styleUrl: './agent-picker.component.scss',
})
export class AgentPickerComponent {
  private readonly state = inject(AppStateService);
  private readonly handoff = inject(AgentSwitchHandoffService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private readonly dialogRef = inject(DialogRef, { optional: true });

  readonly LucideBot = LucideBot;
  readonly LucideCheck = LucideCheck;
  readonly LucideSettings2 = LucideSettings2;

  readonly items = computed(() => buildAgentPickerItems(this.state.detectedAgents() ?? [], this.state.effectiveAgentId()));
  /** The project carries its own agent (or the session does): offer to go back to the default. */
  readonly hasOwnAgent = computed(() => {
    const source = this.state.effectiveAgent()?.source;
    return source === 'project' || source === 'session';
  });
  readonly fellBackFrom = computed(() => this.state.effectiveAgent()?.fellBackFrom ?? null);

  /** `null` removes the project's agent so it follows the global default again. */
  async pick(agentId: string | null): Promise<void> {
    if (agentId !== null && agentId === this.state.effectiveAgentId()) {
      this.dialogRef?.close();
      return;
    }
    const before = this.state.effectiveAgentId();
    const result = await this.state.setProjectAgent(agentId);
    if (!result.accepted) {
      this.toast.show(this.rejectionText(result.rejectedReason), { kind: 'error' });
      return;
    }
    this.handoff.notify(before, result.effective.agentId);
    this.dialogRef?.close();
  }

  openSettings(): void {
    this.dialogRef?.close();
    this.shortcuts.openSettings('execution');
  }

  private rejectionText(reason: string | undefined): string {
    if (reason === 'AGENT_RUN_ACTIVE') return this.translate.instant('statusbar.agent_change_blocked') as string;
    if (reason === 'NO_PROJECT') return this.translate.instant('statusbar.no_project') as string;
    return reason ?? (this.translate.instant('statusbar.agent_change_failed') as string);
  }
}
