import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AlertComponent,
  ButtonComponent,
  CheckboxComponent,
  DialogRef,
  IconComponent,
  SpinnerComponent,
  TooltipDirective,
} from '@devia/ui';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideDownload, LucideX } from '@lucide/angular';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { AppStateService } from '../../core/services/app-state.service';
import { ToastService } from '../../core/services/toast.service';
import type {
  ImportableAgent,
  ImportableProject,
  ImportSelection,
} from '../../../../shared/domain/session-import';

/** Display labels for the agents that expose importable sessions. */
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  grok: 'Grok',
};

/**
 * S-20 (generalises S-18): wizard to import pre-existing CLI-agent sessions into
 * Devia, grouped by agent → project. Each session keeps the agent's native id,
 * so continuing a `resumable` import resumes the real transcript with full
 * context; replay-only agents re-seed the transcript on the next turn.
 */
@Component({
  selector: 'ds-session-import-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, CheckboxComponent, FormsModule, IconComponent, SpinnerComponent, TooltipDirective, TranslateModule],
  templateUrl: './session-import-modal.component.html',
  styleUrl: './session-import-modal.component.scss',
})
export class SessionImportModalComponent {
  private readonly api = inject(ElectronApiService);
  private readonly state = inject(AppStateService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  readonly ref = inject(DialogRef, { optional: true });

  readonly LucideDownload = LucideDownload;
  readonly LucideX = LucideX;

  readonly loading = signal(true);
  readonly importing = signal(false);
  readonly agents = signal<ImportableAgent[]>([]);
  /** Keys (`agentId::projectPath::sessionId`) the user has checked for import. */
  private readonly selected = signal<ReadonlySet<string>>(new Set());
  /** Re-import sessions that already exist in Devia. */
  readonly force = signal(false);

  readonly empty = computed(() => !this.loading() && this.agents().length === 0);
  readonly selectedCount = computed(() => this.selected().size);

  constructor() {
    void this.scan();
  }

  agentLabel(agentId: string): string {
    return AGENT_LABELS[agentId] ?? agentId;
  }

  private keyOf(agentId: string, projectPath: string, sessionId: string): string {
    return `${agentId}::${projectPath}::${sessionId}`;
  }

  /** A session is importable now unless it already exists and force is off. */
  private importable(sessionAlreadyImported: boolean): boolean {
    return this.force() || !sessionAlreadyImported;
  }

  isSelected(agentId: string, projectPath: string, sessionId: string): boolean {
    return this.selected().has(this.keyOf(agentId, projectPath, sessionId));
  }

  isLocked(alreadyImported: boolean): boolean {
    return alreadyImported && !this.force();
  }

  private async scan(): Promise<void> {
    this.loading.set(true);
    try {
      const agents = await this.api.scanSessionImport();
      this.agents.set(agents);
      // Pre-select everything not already imported.
      const preselect = new Set<string>();
      for (const a of agents) {
        for (const p of a.projects) {
          for (const s of p.sessions) {
            if (!s.alreadyImported) preselect.add(this.keyOf(a.agentId, p.projectPath, s.sessionId));
          }
        }
      }
      this.selected.set(preselect);
    } catch {
      this.agents.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  toggle(agentId: string, projectPath: string, sessionId: string, alreadyImported: boolean): void {
    if (this.isLocked(alreadyImported)) return;
    const key = this.keyOf(agentId, projectPath, sessionId);
    const next = new Set(this.selected());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.selected.set(next);
  }

  /** Keys of the sessions in a project that can be (de)selected right now. */
  private selectableKeys(agentId: string, project: ImportableProject): string[] {
    return project.sessions
      .filter((s) => this.importable(s.alreadyImported))
      .map((s) => this.keyOf(agentId, project.projectPath, s.sessionId));
  }

  /** Header checkbox state: true only when every selectable session is selected. */
  isProjectAllSelected(agentId: string, project: ImportableProject): boolean {
    const keys = this.selectableKeys(agentId, project);
    return keys.length > 0 && keys.every((k) => this.selected().has(k));
  }

  /** Every selectable key across all agents/projects (for the global select-all). */
  private allSelectableKeys(): string[] {
    return this.agents().flatMap((a) => a.projects.flatMap((p) => this.selectableKeys(a.agentId, p)));
  }

  /** Global checkbox state: true only when every selectable session is selected. */
  readonly isAllSelected = computed(() => {
    const keys = this.allSelectableKeys();
    return keys.length > 0 && keys.every((k) => this.selected().has(k));
  });

  toggleAll(): void {
    const keys = this.allSelectableKeys();
    const allSelected = keys.length > 0 && keys.every((k) => this.selected().has(k));
    this.selected.set(allSelected ? new Set() : new Set(keys));
  }

  toggleProject(agentId: string, project: ImportableProject): void {
    const keys = this.selectableKeys(agentId, project);
    const allSelected = keys.length > 0 && keys.every((k) => this.selected().has(k));
    const next = new Set(this.selected());
    for (const k of keys) {
      if (allSelected) next.delete(k); else next.add(k);
    }
    this.selected.set(next);
  }

  /** Force off → drop any locked (already-imported) keys from the selection. */
  onForceChange(value: boolean): void {
    this.force.set(value);
    if (value) return;
    const next = new Set<string>();
    for (const a of this.agents()) {
      for (const p of a.projects) {
        for (const s of p.sessions) {
          const key = this.keyOf(a.agentId, p.projectPath, s.sessionId);
          if (this.selected().has(key) && !s.alreadyImported) next.add(key);
        }
      }
    }
    this.selected.set(next);
  }

  async runImport(): Promise<void> {
    if (this.importing() || this.selectedCount() === 0) return;
    const selections: ImportSelection[] = [];
    for (const a of this.agents()) {
      for (const p of a.projects) {
        for (const s of p.sessions) {
          if (this.selected().has(this.keyOf(a.agentId, p.projectPath, s.sessionId))) {
            selections.push({ agentId: a.agentId, projectPath: p.projectPath, sessionId: s.sessionId });
          }
        }
      }
    }
    this.importing.set(true);
    try {
      const summary = await this.api.runSessionImport(selections, { force: this.force() });
      this.toast.show(
        this.translate.instant('modals.session_import.toast_done', {
          imported: summary.imported, skipped: summary.skipped, failed: summary.failed,
        }),
        { kind: summary.failed > 0 ? 'warning' : 'success' },
      );
      // Refresh the active project's session list so imports show immediately.
      const active = this.state.selectedProject();
      if (active) void this.state.refreshSessions(active);
      this.ref?.close(true);
    } catch {
      this.toast.show(this.translate.instant('modals.session_import.toast_error'), { kind: 'error' });
    } finally {
      this.importing.set(false);
    }
  }

  formatDate(ms: number): string {
    try {
      return new Date(ms).toLocaleDateString();
    } catch {
      return '';
    }
  }

  cancel(): void {
    this.ref?.close(false);
  }
}
