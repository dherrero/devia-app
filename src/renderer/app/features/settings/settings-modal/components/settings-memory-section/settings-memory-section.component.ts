import { DEFAULT_AGENT_ID } from '../../../../../../../shared/domain/agent';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, model, signal } from '@angular/core';
import type { DetectedAgentView } from '../../../../../../types/devia';
import { FormsModule } from '@angular/forms';
import { AlertComponent, ButtonComponent, ButtonToggleGroupComponent, DialogService, IconComponent, InputComponent, SpinnerComponent, TooltipDirective } from '@devia/ui';
import { LucideDownload, LucidePin, LucideTrash2 } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import type { EngramDetectionResult, ImportEngramResult, MemoryScope, MemorySession, Observation } from '../../../../../../../shared/domain/memory';
import { AppStateService } from '../../../../../core/services/app-state.service';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { I18nService } from '../../../../../core/i18n/i18n.service';
import { engramErrorKey } from '../../utils/engram-error-key';

@Component({
  selector: 'ds-settings-memory-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    AlertComponent,
    ButtonComponent,
    ButtonToggleGroupComponent,
    IconComponent,
    InputComponent,
    SpinnerComponent,
    TooltipDirective,
    TranslateModule,
  ],
  templateUrl: './settings-memory-section.component.html',
  styleUrl: './settings-memory-section.component.scss',
})
export class SettingsMemorySectionComponent implements OnInit {
  readonly LucideDownload = LucideDownload;
  readonly LucidePin = LucidePin;
  readonly LucideTrash2 = LucideTrash2;

  /** Persisted memory toggles — owned by the parent (snapshot/save). */
  readonly memoryEnabled = model(true);
  /**
   * Isolate the run to Devia's MCP servers (Claude `--strict-mcp-config`),
   * blocking ANY ambient external memory MCP — engram, mcp-memory-service, the
   * official memory server, hand-edited `.mcp.json`. Provider-neutral.
   */
  readonly memoryBlockExternal = model(true);
  readonly selectedAgentId = input(DEFAULT_AGENT_ID);

  private readonly api = inject(ElectronApiService);
  private readonly state = inject(AppStateService);
  private readonly dialogs = inject(DialogService);
  private readonly translate = inject(TranslateService);
  readonly i18n = inject(I18nService);

  /**
   * Single user-facing control mapping the two booleans to a memory provider:
   *   devia    → Devia's internal memory ON  + external isolated (recommended).
   *   external → Devia OFF + external memory MCP allowed to run (Claude/OpenCode only).
   *   none     → Devia OFF + external isolated (no memory).
   */
  readonly memoryProvider = computed<'devia' | 'external' | 'none'>(() => {
    if (this.memoryEnabled()) return 'devia';
    return this.memoryBlockExternal() ? 'none' : 'external';
  });
  setMemoryProvider(provider: string): void {
    const p = provider as 'devia' | 'external' | 'none';
    this.memoryEnabled.set(p === 'devia');
    this.memoryBlockExternal.set(p !== 'external');
  }
  readonly memoryProviderItems = computed(() => {
    this.i18n.currentLanguage();
    return [
      { id: 'devia',    label: this.translate.instant('modals.settings.memory_provider_devia') },
      { id: 'external', label: this.translate.instant('modals.settings.memory_provider_external') },
      { id: 'none',     label: this.translate.instant('modals.settings.memory_provider_none') },
    ];
  });
  readonly engramDetection = signal<EngramDetectionResult | null>(null);
  readonly engramImporting = signal(false);
  readonly engramImportResult = signal<ImportEngramResult | null>(null);
  readonly engramImportedAt = signal<number | null>(null);
  /** The selected agent's view; its `harness` comes from the agent's mapper. */
  readonly selectedAgent = input<DetectedAgentView | undefined>(undefined);
  /** External-memory isolation needs a CLI that can load ONLY Devia's MCP
   *  servers; the agent's mapper says whether it can (S-30 contract A). An agent
   *  without MCP at all has nothing to isolate, so no warning for it. */
  readonly externalBlockUnsupportedAgent = computed(() => {
    const harness = this.selectedAgent()?.harness;
    return harness !== undefined && harness.mcp !== 'none' && !harness.isolatesExternalMcp;
  });
  /** Exposed so the template can map an import error reason to an i18n key. */
  readonly engramErrorKey = engramErrorKey;

  // ── Memory management panel (E-DSK-13 #320) ───────────────────────────────
  // Defaults to the ACTIVE project's project-scope store (where the agent's
  // `mem_save` lands by default), with a toggle to the cross-project personal
  // store. Falls back to personal when no project is selected.
  readonly memoryItems = signal<Observation[]>([]);
  /** Recent session summaries — the bulk of a project's memory is auto-captured
   *  run summaries, not observations, so the panel surfaces them as history. */
  readonly memorySessions = signal<MemorySession[]>([]);
  readonly memorySearchQuery = signal('');

  /** Path of the currently selected project (null when none). */
  readonly activeProjectPath = computed(() => this.state.selectedProject());
  /** Basename of the active project path, shown in the "memoria proyecto: X"
   *  label. Computed in the renderer (no Node `path` available here). */
  readonly activeProjectName = computed<string | null>(() => {
    const p = this.activeProjectPath();
    if (!p) return null;
    const parts = p.split(/[\\/]+/).filter(Boolean);
    return parts.length ? (parts[parts.length - 1] ?? null) : p;
  });
  /** Which store the saved-memory panel reads. 'project' when a project is
   *  active, else 'personal'. Set in ngOnInit once the project is known. */
  readonly memoryViewScope = signal<MemoryScope>('personal');
  readonly memoryScopeItems = computed(() => {
    this.i18n.currentLanguage();
    return [
      { id: 'project',  label: this.translate.instant('modals.settings.memory_scope_project') },
      { id: 'personal', label: this.translate.instant('modals.settings.memory_scope_personal') },
    ];
  });

  ngOnInit(): void {
    // Hydrate the last-import timestamp from the persisted config and probe
    // for an engram install (both best-effort, as the pre-split modal did).
    void this.api.getConfig()
      .then((cfg) => this.engramImportedAt.set(cfg.memory?.engramImportedAt ?? null))
      .catch(() => { /* best-effort; leave null */ });
    void this.api.detectEngram()
      .then((d) => this.engramDetection.set(d))
      .catch(() => { /* detection is best-effort; leave null */ });
    // Show the active project's memory by default — that's where the agent's
    // `mem_save` lands; personal stays one toggle away.
    this.memoryViewScope.set(this.activeProjectPath() ? 'project' : 'personal');
    void this.loadMemoryItems();
  }

  /** Builds the scope/projectPath args for the memory bridge calls. Project
   *  scope needs the active path; with no project we degrade to personal. */
  private memoryScopeArgs(): { scope: MemoryScope; projectPath?: string } {
    if (this.memoryViewScope() === 'project') {
      const path = this.activeProjectPath();
      if (path) return { scope: 'project', projectPath: path };
    }
    return { scope: 'personal' };
  }

  setMemoryViewScope(scope: string): void {
    this.memoryViewScope.set(scope as MemoryScope);
    this.memorySearchQuery.set('');
    void this.loadMemoryItems();
  }

  private async loadMemoryItems(): Promise<void> {
    const args = this.memoryScopeArgs();
    try {
      this.memoryItems.set(await this.api.listMemory({ ...args, limit: 50 }));
    } catch {
      this.memoryItems.set([]);
    }
    try {
      this.memorySessions.set(await this.api.listMemorySessions({ ...args, limit: 50 }));
    } catch {
      this.memorySessions.set([]);
    }
  }

  async runMemorySearch(): Promise<void> {
    const query = this.memorySearchQuery().trim();
    if (!query) { await this.loadMemoryItems(); return; }
    try {
      const hits = await this.api.searchMemory({ query, ...this.memoryScopeArgs(), limit: 50 });
      this.memoryItems.set(hits.map((h) => h.observation));
    } catch {
      this.memoryItems.set([]);
    }
  }

  async togglePin(obs: Observation): Promise<void> {
    const updated = await this.api.setMemoryPinned({ id: obs.id, pinned: !obs.pinned, ...this.memoryScopeArgs() });
    if (updated) this.memoryItems.update((list) => list.map((o) => (o.id === obs.id ? updated : o)));
  }

  async forgetObservation(obs: Observation): Promise<void> {
    const ok = await this.api.forgetMemory({ id: obs.id, ...this.memoryScopeArgs() });
    if (ok) this.memoryItems.update((list) => list.filter((o) => o.id !== obs.id));
  }

  async clearAllMemory(): Promise<void> {
    const ok = await firstValueFrom(
      this.dialogs.confirm({
        title: this.translate.instant('modals.settings.memory_clear_title'),
        message: this.translate.instant('modals.settings.memory_clear_message'),
        confirmLabel: this.translate.instant('modals.settings.memory_clear_confirm'),
        cancelLabel: this.translate.instant('modals.settings.cancel'),
        danger: true,
      }),
    );
    if (!ok) return;
    await this.api.clearMemory({ ...this.memoryScopeArgs() });
    this.memoryItems.set([]);
    this.memorySessions.set([]);
  }

  /** Detect + import engram memory into Devia's personal store (S-1).
   *  The import marks `config.memory.engramImported(At)` in the main process;
   *  the parent re-reads the persisted memory block at save time. */
  async doImportEngram(): Promise<void> {
    if (this.engramImporting()) return;
    this.engramImporting.set(true);
    try {
      const r = await this.api.importEngram();
      this.engramImportResult.set(r);
      if (r.ok) this.engramImportedAt.set(Date.now());
    } finally {
      this.engramImporting.set(false);
    }
  }

  formatImportedAt(ts: number): string {
    return new Date(ts).toLocaleString();
  }
}
