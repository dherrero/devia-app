import { DEFAULT_AGENT_ID } from '../../../../../../../shared/domain/agent';
import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AlertComponent, ButtonComponent, IconComponent, InputComponent, SelectComponent, ToggleComponent, TooltipDirective } from '@devia/ui';
import { LucideChevronRight, LucideInfo, LucidePlay, LucideSearch } from '@lucide/angular';
import { TranslateModule } from '@ngx-translate/core';
import type { DetectedAgentView } from '../../../../../../types/devia';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import type { AgentForm } from '../../models/settings-forms.model';
import { filterVisibleAgents, getNextAgentPanelState } from './settings-execution-section.utils';

@Component({
  selector: 'ds-settings-execution-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, AlertComponent, ButtonComponent, IconComponent, InputComponent, SelectComponent, ToggleComponent, TooltipDirective, TranslateModule],
  templateUrl: './settings-execution-section.component.html',
  styleUrl: './settings-execution-section.component.scss',
})
export class SettingsExecutionSectionComponent implements OnDestroy {
  readonly LucidePlay = LucidePlay;
  readonly LucideSearch = LucideSearch;
  readonly LucideChevronRight = LucideChevronRight;
  readonly LucideInfo = LucideInfo;

  readonly agents = input<DetectedAgentView[]>([]);
  readonly loadingAgents = input(true);
  readonly selectedAgentId = input(DEFAULT_AGENT_ID);
  readonly agentForm = model.required<AgentForm>();
  readonly autoContinueSessions = model<Record<string, boolean>>({});
  /** Emits the clicked agent id; the parent owns the selection (guards +
   *  re-hydration of the agent form). */
  readonly agentSelected = output<string>();
  /** S-20: open the agent session import wizard (shown for agents with an importer). */
  readonly importSessions = output<void>();

  private readonly api = inject(ElectronApiService);

  readonly testing = signal(false);
  readonly agentSearch = signal('');
  readonly expandedAgentId = signal<string | null>(null);
  readonly envExpanded = signal(false);
  private readonly agentSearchQuery = signal('');
  private agentSearchDebounceId: ReturnType<typeof setTimeout> | null = null;
  // REV-TS-CLI-13-03: testResult is now a full DetectedAgentView (returned by
  // the agent:test IPC) so the UI can display authStatus, diagnostic, etc.
  readonly testResult = signal<DetectedAgentView | null>(null);
  // UC-FIX-017: tracks which secret keys are in edit mode (masked → editable).
  private readonly secretEditKeys = signal<Set<string>>(new Set());

  readonly selectedAgent = computed(() =>
    this.agents().find((a) => a.id === this.selectedAgentId()) ?? null,
  );
  readonly visibleAgents = computed(() => {
    return filterVisibleAgents(this.agents(), this.selectedAgentId(), this.agentSearchQuery());
  });

  constructor() {
    // The pre-split code cleared these whenever a different agent was
    // accepted; mirror that by resetting when the bound selection changes.
    effect(() => {
      const selectedAgentId = this.selectedAgentId();
      this.expandedAgentId.set(selectedAgentId);
      this.envExpanded.set(false);
      this.testResult.set(null);
      this.secretEditKeys.set(new Set());
    });
  }

  ngOnDestroy(): void {
    if (this.agentSearchDebounceId !== null) {
      clearTimeout(this.agentSearchDebounceId);
    }
  }

  onAgentSearchChange(value: string): void {
    this.agentSearch.set(value);
    if (this.agentSearchDebounceId !== null) {
      clearTimeout(this.agentSearchDebounceId);
    }
    this.agentSearchDebounceId = setTimeout(() => {
      this.agentSearchQuery.set(value);
      this.agentSearchDebounceId = null;
    }, 120);
  }

  selectAgent(agent: DetectedAgentView): void {
    if (!agent.selectable) return;

    const nextPanelState = getNextAgentPanelState(
      this.selectedAgentId(),
      this.expandedAgentId(),
      agent.id,
    );
    this.expandedAgentId.set(nextPanelState.expandedAgentId);
    if (nextPanelState.resetEnv) {
      this.envExpanded.set(false);
    }

    if (nextPanelState.emitSelection) {
      this.agentSelected.emit(agent.id);
    }
  }

  toggleEnv(): void {
    this.envExpanded.update((expanded) => !expanded);
  }

  updateAgentForm<K extends keyof Omit<AgentForm, 'env'>>(key: K, value: AgentForm[K]): void {
    this.agentForm.update((form) => ({ ...form, [key]: value }));
  }

  setAutoContinue(agentId: string, enabled: boolean): void {
    this.autoContinueSessions.update((m) => ({ ...m, [agentId]: enabled }));
  }

  isSecret(key: string): boolean {
    return /API_KEY|TOKEN|SECRET/i.test(key);
  }

  isEditingSecret(key: string): boolean {
    return this.secretEditKeys().has(key);
  }

  startEditSecret(key: string): void {
    const next = new Set(this.secretEditKeys());
    next.add(key);
    this.secretEditKeys.set(next);
    // Clear the current value so the user types a new one from scratch.
    this.agentForm.update((f) => ({ ...f, env: { ...f.env, [key]: '' } }));
  }

  onEnvChange(key: string, value: string) {
    this.agentForm.update((f) => ({ ...f, env: { ...f.env, [key]: value } }));
  }

  async testAgent() {
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const result = await this.api.testAgent(this.selectedAgentId());
      this.testResult.set(result);
    } finally {
      this.testing.set(false);
    }
  }
}
