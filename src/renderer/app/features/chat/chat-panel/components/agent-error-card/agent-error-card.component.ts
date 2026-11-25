import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ButtonComponent } from '@devia/ui';
import type { ErrorAction, UserFacingError } from '../../../../../../../shared/domain/user-facing-error';
import { agentErrorText } from '../../../../../core/utils/agent-error-text';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { KeyboardShortcutsService } from '../../../../../core/layout/keyboard-shortcuts.service';
import { ToastService } from '../../../../../core/services/toast.service';

/**
 * What an agent failure says to the user (S-54): what happened, the likely
 * cause, buttons for what to do, and the raw agent message folded away.
 */
@Component({
  selector: 'ds-agent-error-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, TranslateModule],
  templateUrl: './agent-error-card.component.html',
  styleUrl: './agent-error-card.component.scss',
})
export class AgentErrorCardComponent {
  readonly error = input.required<UserFacingError>();
  /** The "Retry" action: the chat panel owns re-sending the last turn. */
  readonly retry = output<void>();

  private readonly translate = inject(TranslateService);
  private readonly api = inject(ElectronApiService);
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private readonly toast = inject(ToastService);

  readonly text = computed(() => agentErrorText(this.translate, this.error()));
  readonly buttons = computed(() => this.error().actions.filter((a) => a.kind !== 'copy_details'));
  readonly canCopy = computed(() => this.error().actions.some((a) => a.kind === 'copy_details'));

  labelKey(action: ErrorAction): string {
    return `agent_error.actions.${action.kind}`;
  }

  async run(action: ErrorAction): Promise<void> {
    switch (action.kind) {
      case 'open_settings':
        this.shortcuts.openSettings(action.section);
        return;
      case 'pick_model':
      case 'login':
        this.shortcuts.openSettings('execution');
        return;
      case 'retry':
        this.retry.emit();
        return;
      case 'enable_auto_continue':
        await this.enableAutoContinue(action.agentId);
        return;
      case 'copy_details':
        await this.copy();
        return;
    }
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.error().details);
      this.toast.show(this.translate.instant('agent_error.copied'));
    } catch {
      /* clipboard unavailable: the details stay visible in the card */
    }
  }

  private async enableAutoContinue(agentId: string): Promise<void> {
    const cfg = await this.api.getConfig();
    await this.api.setConfig({ autoContinueSessions: { ...(cfg.autoContinueSessions ?? {}), [agentId]: true } });
    this.toast.show(this.translate.instant('agent_error.auto_continue_enabled'));
  }
}
