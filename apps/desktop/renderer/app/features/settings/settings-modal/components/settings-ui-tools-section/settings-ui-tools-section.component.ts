import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, signal } from '@angular/core';
import type { DetectedAgentView } from '../../../../../../types/devia';
import { ButtonComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';

import {
  approxTokens,
  type ConfirmationGrant,
  type UiToolCatalogEntry,
  type UiToolName,
} from '../../../../../../../shared/domain/ui-tools';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';

/**
 * Settings → interface tools (S-25 F3.3).
 *
 * Two jobs in one section, because they are the same subject: which tools the
 * agent is offered, and which destructive actions the user pre-authorised.
 *
 * Every toggle shows what its schema COSTS, because that is the trade-off the
 * user is actually making — the schemas sit in the cached prompt prefix on
 * every single turn.
 */
@Component({
  selector: 'ds-settings-ui-tools-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, TranslateModule],
  templateUrl: './settings-ui-tools-section.component.html',
  styleUrl: './settings-ui-tools-section.component.scss',
})
export class SettingsUiToolsSectionComponent {
  private readonly api = inject(ElectronApiService);

  /** Two-way with the modal: an absent entry means "use the mode default". */
  readonly enabled = model<Partial<Record<UiToolName, boolean>>>({});
  /** Drives the "not available with this agent" note. */
  readonly selectedAgentId = input<string>('');
  readonly project = input<string>('');

  protected readonly catalog = signal<UiToolCatalogEntry[]>([]);
  protected readonly grants = signal<ConfirmationGrant[]>([]);

  /** The selected agent's view; its `harness` comes from the agent's mapper. */
  readonly selectedAgent = input<DetectedAgentView | undefined>(undefined);

  /**
   * An agent that cannot receive MCP never gets the server, so every toggle is
   * moot for it. Unknown (not detected yet) counts as supported.
   */
  readonly agentSupported = computed(() => this.selectedAgent()?.harness?.mcp !== 'none');

  readonly activeChars = computed(() =>
    this.catalog()
      .filter((t) => this.isOn(t.name))
      .reduce((sum, t) => sum + t.schemaChars, 0),
  );

  readonly activeTokens = computed(() => approxTokens(this.activeChars()));

  constructor() {
    // NOT in the constructor body: `input()` values are bound AFTER the
    // component is created, so a direct call here would always read an empty
    // project and silently show no grants. The effect also re-reads when the
    // selected project changes.
    effect(() => void this.reload(this.project()));
  }

  async reload(project = this.project()): Promise<void> {
    const [catalog, grants] = await Promise.all([
      this.api.listUiToolCatalog().catch(() => []),
      project ? this.api.listUiToolGrants(project).catch(() => []) : Promise.resolve([]),
    ]);
    this.catalog.set(catalog);
    this.grants.set(grants);
  }

  tokensOf(tool: UiToolCatalogEntry): number {
    return approxTokens(tool.schemaChars);
  }

  /** Absent means "mode default", which is on wherever the policy offers it. */
  protected isOn(name: UiToolName): boolean {
    return this.enabled()[name] !== false;
  }

  protected toggle(name: UiToolName): void {
    const next = { ...this.enabled() };
    if (this.isOn(name)) next[name] = false;
    else delete next[name];
    this.enabled.set(next);
  }

  protected async revoke(action: string): Promise<void> {
    await this.api.revokeUiToolGrant(this.project(), action);
    await this.reload();
  }

  protected async revokeAll(): Promise<void> {
    await this.api.revokeUiToolGrant(this.project());
    await this.reload();
  }
}
