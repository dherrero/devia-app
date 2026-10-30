import { DEFAULT_AGENT_ID } from '../../../../../shared/domain/agent';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { SessionImportModalComponent } from '../../session-import/session-import-modal.component';
import type { MenuActionItemDef } from '@devia/ui';
import { AlertComponent, ButtonComponent, DIALOG_DATA, DialogRef, IconComponent, MenuItemComponent, SelectComponent } from '@devia/ui';
import { FormsModule } from '@angular/forms';
import { LucideCpu, LucideFolder, LucideLayoutPanelLeft, LucidePalette, LucideRadio, LucideRocket, LucideSettings, LucideX } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import type { MemoryConfig, RemoteControlConfig } from '../../../../../shared/domain/config';
import type { RemoteControlStatus } from '../../../../../shared/domain/remote-control';
import type { AuditEntry, DetectedAgentView } from '../../../../types/devia';
import { AppStateService } from '../../../core/services/app-state.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { I18nService } from '../../../core/i18n/i18n.service';
import {
  applyStyle,
  applyTheme,
  resolveStyle,
  resolveTheme,
  type Theme,
} from '../../../core/theme/accent-palettes';
import { ToastService } from '../../../core/services/toast.service';
import {
  buildHandoffRequestPrompt,
  canRequestHandoffSummary,
  detectPendingHandoff,
} from '../../chat/chat-panel/utils/agent-handoff.util';
import type { ModalNavSection } from '../../../shared/components/modal-shell/modal-shell.component';
import type { AgentForm, RemoteForm, WorkspaceForm } from './models/settings-forms.model';
import { SettingsAppearanceSectionComponent } from './components/settings-appearance-section/settings-appearance-section.component';
import { SettingsExecutionSectionComponent } from './components/settings-execution-section/settings-execution-section.component';
import { SettingsMemorySectionComponent } from './components/settings-memory-section/settings-memory-section.component';
import { SettingsUiToolsSectionComponent } from './components/settings-ui-tools-section/settings-ui-tools-section.component';
import type { UiToolName } from '../../../../../shared/domain/ui-tools';
import { SettingsRemoteSectionComponent } from './components/settings-remote-section/settings-remote-section.component';
import { SettingsWorkspaceSectionComponent } from './components/settings-workspace-section/settings-workspace-section.component';

function isDarkTheme(theme: Theme): boolean {
  return theme === 'dark' || theme === 'navy-dark';
}

function isNavyTheme(theme: Theme): boolean {
  return theme === 'navy' || theme === 'navy-dark';
}

function settingsThemeKey(dark: boolean, sharp: boolean): Theme {
  if (sharp) return dark ? 'navy-dark' : 'navy';
  return dark ? 'dark' : 'light';
}

@Component({
  selector: 'ds-settings-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    ButtonComponent,
    FormsModule,
    IconComponent,
    MenuItemComponent,
    SelectComponent,
    TranslateModule,
    SettingsAppearanceSectionComponent,
    SettingsExecutionSectionComponent,
    SettingsMemorySectionComponent,
    SettingsUiToolsSectionComponent,
    SettingsRemoteSectionComponent,
    SettingsWorkspaceSectionComponent,
  ],
  templateUrl: './settings-modal.component.html',
  styleUrl: './settings-modal.component.scss',
})
export class SettingsModalComponent implements OnInit {
  readonly LucideSettings = LucideSettings;
  readonly LucideX = LucideX;

  readonly isDark  = signal(isDarkTheme(resolveTheme()));
  readonly isSharp = signal(resolveStyle() === 'sharp' || isNavyTheme(resolveTheme()));
  private initialTheme: Theme = resolveTheme();
  private initialStyle: 'rounded' | 'sharp' = resolveStyle();

  setTheme(theme: 'light' | 'dark'): void {
    const dark = theme === 'dark';
    applyTheme(settingsThemeKey(dark, this.isSharp()));
    this.isDark.set(dark);
  }

  setStyle(style: 'rounded' | 'sharp'): void {
    const sharp = style === 'sharp';
    applyStyle(style);
    applyTheme(settingsThemeKey(this.isDark(), sharp));
    this.isSharp.set(sharp);
  }

  private readonly api = inject(ElectronApiService);
  readonly state = inject(AppStateService);
  readonly ref = inject(DialogRef, { optional: true });
  private readonly dialog = inject(Dialog);
  readonly i18n = inject(I18nService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  /** Optional initial section, passed by the opener (e.g. the engram warning
   *  toast opens directly on 'memory'). */
  private readonly data = inject<{ section?: string } | null>(DIALOG_DATA, { optional: true });

  /** Active left-rail section. */
  readonly active = signal<string>('workspace');
  /** Section list for the shell, re-translated when the language changes
   *  (the language switcher lives in this very modal). */
  readonly sections = computed<ModalNavSection[]>(() => {
    this.i18n.currentLanguage();
    return [
      { id: 'workspace', label: this.translate.instant('modals.settings.tab_workspace'), icon: LucideFolder },
      { id: 'execution', label: this.translate.instant('modals.settings.tab_execution'), icon: LucideRocket },
      { id: 'appearance', label: this.translate.instant('modals.settings.tab_appearance'), icon: LucidePalette },
      { id: 'memory', label: this.translate.instant('modals.settings.tab_memory'), icon: LucideCpu },
      { id: 'ui-tools', label: this.translate.instant('modals.settings.tab_ui_tools'), icon: LucideLayoutPanelLeft },
      { id: 'remote-control', label: this.translate.instant('modals.settings.tab_remote_control'), icon: LucideRadio },
    ];
  });
  readonly settingsMenuItems = computed<MenuActionItemDef[]>(() =>
    this.sections().map((item) => ({
      id: item.id,
      label: item.label,
      icon: item.icon,
    })),
  );

  activateSection(item: MenuActionItemDef): void {
    if (!item.id) return;
    this.active.set(item.id);
  }

  /** S-20: open the agent session import wizard on top of Settings. */
  openSessionImport(): void {
    this.dialog.open(SessionImportModalComponent, {
      width: 'min(46rem, calc(100vw - 2rem))',
      maxWidth: 'calc(100vw - 2rem)',
      height: 'min(34rem, calc(100vh - 2rem))',
      maxHeight: 'calc(100vh - 2rem)',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }

  readonly workspaceForm = signal<WorkspaceForm>({
    workspaceRoot: '', ignoreFolders: '',
  });
  readonly agentForm = signal<AgentForm>({ model: 'default', reasoning: 'default', env: {} });
  readonly configPath = signal('');
  readonly saving = signal(false);
  private readonly persistedSnapshot = signal('');

  readonly agents = signal<DetectedAgentView[]>([]);
  /** The selected agent's view — carries its harness capabilities (S-30). */
  readonly selectedAgent = computed(() => this.agents().find((a) => a.id === this.selectedAgentId()));
  readonly loadingAgents = signal(true);
  readonly selectedAgentId = signal<string>(DEFAULT_AGENT_ID);
  readonly errorBanner = signal<string | null>(null);
  private persistedAgentId = DEFAULT_AGENT_ID;

  readonly currentSnapshot = computed(() => stableSettingsSnapshot({
    workspace: this.workspaceForm(),
    agentId: this.selectedAgentId(),
    agent: this.agentForm(),
    memory: {
      enabled: this.memoryEnabled(),
      blockExternalMemory: this.memoryBlockExternal(),
    },
    uiTools: this.uiToolsEnabled(),
    autoContinue: this.autoContinueSessions(),
    remote: this.remoteForm(),
    // Appearance is applied live (localStorage) but reverts on close-without-save.
    // Tracking it here marks the form dirty so Save enables and commits it.
    appearance: { dark: this.isDark(), sharp: this.isSharp() },
  }));
  readonly hasChanges = computed(() => {
    const persisted = this.persistedSnapshot();
    return persisted !== '' && this.currentSnapshot() !== persisted;
  });

  // ── Audit Log tab ─────────────────────────────────────────────────
  readonly auditEntries = signal<AuditEntry[]>([]);
  readonly auditLoading = signal(false);
  private auditLoaded = false;

  // ── Memory tab (S-1) — persisted toggles; the section UI lives in
  //    ds-settings-memory-section, bound through the two models below. ───────
  private currentMemory: MemoryConfig = { enabled: true, blockExternalMemory: true, engramImported: false };
  readonly memoryEnabled = signal(true);
  readonly memoryBlockExternal = signal(true);

  // ── Interface tools tab (S-25 F3.3) ───────────────────────────────────────
  // An absent entry means "use the run-mode default"; only an explicit `false`
  // withholds a tool. A preference can never WIDEN the policy.
  readonly uiToolsEnabled = signal<Partial<Record<UiToolName, boolean>>>({});

  /** Per-agent switch: resume a session cut short by the account's usage limit. */
  readonly autoContinueSessions = signal<Record<string, boolean>>({});

  /** S-3 F1.2: which ref session worktrees branch from. */
  readonly worktreeBaseRef = signal<'default-branch' | 'current'>('default-branch');

  // ── Remote control tab (E-DSK-14) — Telegram ──────────────────────────────
  private currentRemote: RemoteControlConfig = {
    allowShell: false,
    mirrorDesktop: false,
    allowFileSend: true,
    telegram: { enabled: false, botToken: '', chatId: '' },
  };
  readonly remoteForm = signal<RemoteForm>({
    enabled: false, botToken: '', chatId: '', allowShell: false, mirrorDesktop: false, allowFileSend: true,
  });
  /** Kept in the parent (two-way bound to the section) so save() can reflect
   *  the controller restart in the section's status pill. */
  readonly remoteStatus = signal<RemoteControlStatus>({ state: 'disabled' });

  async ngOnInit() {
    // Open directly on the requested section when the opener passed one.
    if (this.data?.section) this.active.set(this.data.section);

    const cfg = await this.api.getConfig();
    this.configPath.set(cfg.configPath ?? '');
    this.workspaceForm.set({
      workspaceRoot: cfg.workspaceRoot ?? '',
      ignoreFolders: (cfg.ignoreFolders ?? []).join(', '),
    });
    this.persistedAgentId = cfg.agentId ?? DEFAULT_AGENT_ID;
    this.selectedAgentId.set(this.persistedAgentId);
    this.hydrateAgentForm(cfg.agentId ?? DEFAULT_AGENT_ID, cfg.agentModels ?? {}, cfg.agentCliEnv ?? {});

    // S-3 F1.2: ref the session worktrees branch from.
    this.worktreeBaseRef.set(cfg.worktreeBaseRef ?? 'default-branch');

    // S-1: hydrate the memory toggles (the memory section handles engram
    // detection and the saved-memory browser itself when mounted).
    const mem = cfg.memory ?? this.currentMemory;
    this.currentMemory = mem;
    this.memoryEnabled.set(mem.enabled);
    this.memoryBlockExternal.set(mem.blockExternalMemory);

    // S-25 F3.3: absent config means "every tool at its mode default".
    this.uiToolsEnabled.set({ ...(cfg.uiTools?.enabled ?? {}) });
    this.autoContinueSessions.set({ ...(cfg.autoContinueSessions ?? {}) });

    // E-DSK-14: hydrate the remote-control form (the remote section loads the
    // current connection status itself when mounted).
    const rc = cfg.remoteControl ?? this.currentRemote;
    this.currentRemote = rc;
    this.remoteForm.set({
      enabled: rc.telegram.enabled,
      botToken: rc.telegram.botToken,
      chatId: rc.telegram.chatId,
      allowShell: rc.allowShell,
      mirrorDesktop: rc.mirrorDesktop ?? false,
      allowFileSend: rc.allowFileSend ?? true,
    });

    this.initialTheme = settingsThemeKey(this.isDark(), this.isSharp());
    this.initialStyle = this.isSharp() ? 'sharp' : 'rounded';
    this.persistedSnapshot.set(this.currentSnapshot());

    // Revert the live preview if the user dismisses the dialog without
    // pressing Save (mat-dialog-close button, Esc, backdrop click).
    this.ref?.closed.subscribe((saved) => {
      if (saved === true) return;
      const currentTheme = settingsThemeKey(this.isDark(), this.isSharp());
      const currentStyle = this.isSharp() ? 'sharp' : 'rounded';
      if (currentTheme !== this.initialTheme) {
        applyTheme(this.initialTheme);
        this.isDark.set(isDarkTheme(this.initialTheme));
      }
      if (currentStyle !== this.initialStyle) {
        applyStyle(this.initialStyle);
        this.isSharp.set(this.initialStyle === 'sharp' || isNavyTheme(this.initialTheme));
      }
    });

    const cached = this.state.detectedAgents();
    if (cached !== null) {
      this.agents.set(cached);
      this.hydrateAgentForm(cfg.agentId ?? DEFAULT_AGENT_ID, cfg.agentModels ?? {}, cfg.agentCliEnv ?? {});
      this.loadingAgents.set(false);
    }

    this.api.listAgents()
      .then((detected) => {
        this.agents.set(detected);
        this.state.detectedAgents.set(detected);
        if (cached === null) this.hydrateAgentForm(cfg.agentId ?? DEFAULT_AGENT_ID, cfg.agentModels ?? {}, cfg.agentCliEnv ?? {});
      })
      .catch(() => { /* silent — cached view remains if available */ })
      .finally(() => { if (cached === null) this.loadingAgents.set(false); });
  }

  private hydrateAgentForm(
    agentId: string,
    models: Record<string, { model?: string; reasoning?: string }>,
    envs: Record<string, Record<string, string>>,
  ) {
    const prefs = models[agentId] ?? {};
    this.agentForm.set({
      model: prefs.model ?? 'default',
      reasoning: prefs.reasoning ?? 'default',
      env: { ...(envs[agentId] ?? {}) },
    });
  }

  async selectAgent(agentId: string) {
    if (agentId === this.selectedAgentId()) return;
    // Refuse to highlight non-selectable entries (planned / api / mcp /
    // local-model). The main process also rejects them via
    // SelectAgentUseCase, but blocking here keeps the UI in sync.
    const target = this.agents().find((a) => a.id === agentId);
    if (target && !target.selectable) return;
    this.selectedAgentId.set(agentId);
    this.errorBanner.set(null);
    const cfg = await this.api.getConfig();
    this.hydrateAgentForm(agentId, cfg.agentModels ?? {}, cfg.agentCliEnv ?? {});
  }

  async save() {
    this.saving.set(true);
    this.errorBanner.set(null);
    try {
      // The memory section refreshes engramImported/engramImportedAt when the
      // user imports engram; re-read the persisted block so saving the toggles
      // preserves those fields.
      let persistedMemory = this.currentMemory;
      try {
        const latest = await this.api.getConfig();
        if (latest.memory) persistedMemory = latest.memory;
      } catch {
        /* fall back to the open-time snapshot */
      }

      const w = this.workspaceForm();
      await this.state.saveConfig({
        workspaceRoot: w.workspaceRoot.trim(),
        ignoreFolders: w.ignoreFolders.split(',').map((s) => s.trim()).filter(Boolean),
        // S-3 F1.2: worktree branching ref.
        worktreeBaseRef: this.worktreeBaseRef(),
        // S-1: persist the memory toggles, preserving engramImported/at.
        uiTools: { enabled: this.uiToolsEnabled() },
        autoContinueSessions: this.autoContinueSessions(),
        // S-1: persist the memory toggles, preserving engramImported/at.
        memory: {
          ...persistedMemory,
          enabled: this.memoryEnabled(),
          blockExternalMemory: this.memoryBlockExternal(),
        },
        // E-DSK-14: persist the remote-control settings.
        remoteControl: {
          allowShell: this.remoteForm().allowShell,
          mirrorDesktop: this.remoteForm().mirrorDesktop,
          allowFileSend: this.remoteForm().allowFileSend,
          telegram: {
            enabled: this.remoteForm().enabled,
            botToken: this.remoteForm().botToken.trim(),
            chatId: this.remoteForm().chatId.trim(),
          },
        },
      });

      // Re-read config and (re)start/stop the Telegram controller so the
      // change takes effect immediately without an app restart.
      try {
        this.remoteStatus.set(await this.api.remoteControlRestart());
      } catch {
        /* controller restart is best-effort; settings are already saved */
      }
      // Lock the dialog's revert target to the just-saved values so a quick
      // peek-then-close after save doesn't roll them back.
      this.initialTheme = settingsThemeKey(this.isDark(), this.isSharp());
      this.initialStyle = this.isSharp() ? 'sharp' : 'rounded';

      const agentId = this.selectedAgentId();
      const previousAgentId = this.persistedAgentId;
      const result = await this.api.selectAgent(agentId);

      if (!result.accepted) {
        this.selectedAgentId.set(this.persistedAgentId);
        this.errorBanner.set(result.rejectedReason ?? 'No se pudo seleccionar el agente.');
        return;
      }

      this.persistedAgentId = result.agentId;
      this.notifyPendingHandoff(previousAgentId, result.agentId);

      const af = this.agentForm();
      await this.api.setAgentModel({
        agentId,
        model: af.model === 'default' ? null : af.model,
        reasoning: af.reasoning === 'default' ? null : af.reasoning,
      });
      await this.api.setAgentEnv({ agentId, env: af.env });

      this.persistedSnapshot.set(this.currentSnapshot());
      this.ref?.close(true);
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * S-2 F3.3: after a successful agent switch, inform (no confirmation — the
   * base handoff is automatic on the next prompt) when the focused session or
   * other mounted panes belong to a different agent.
   */
  private notifyPendingHandoff(previousAgentId: string, newAgentId: string): void {
    if (previousAgentId === newAgentId) return;
    const pending = detectPendingHandoff({
      newAgentId,
      focusedKey: this.state.focusedSessionKey() ?? this.state.selectedProject(),
      mountedKeys: [...this.state.mountedPaneSessions()],
      chats: this.state.chats(),
    });
    if (!pending) return;
    const fromLabel =
      this.agents().find((a) => a.id === pending.fromAgentId)?.name ?? pending.fromAgentId;
    const others = pending.affectedKeys.length - 1;
    const text = others > 0
      ? (this.translate.instant('toasts.agent_handoff_pending_multi', { from: fromLabel, count: others }) as string)
      : (this.translate.instant('toasts.agent_handoff_pending', { from: fromLabel }) as string);
    // F3.4: offer to ask the PREVIOUS agent for a rich handoff summary — only
    // when it is still operative (detected + selectable + authenticated).
    const action = canRequestHandoffSummary(this.agents(), pending.fromAgentId)
      ? {
          label: this.translate.instant('toasts.agent_handoff_request_action', { from: fromLabel }) as string,
          onAction: () => this.requestHandoffSummary(pending.fromAgentId),
        }
      : undefined;
    this.toast.show(text, { kind: 'warning', durationMs: 10_000, ...(action !== undefined && { action }) });
  }

  /**
   * S-2 F3.4: run an internal instruction on the FOCUSED session with the
   * PREVIOUS agent (agentIdOverride) so it records a rich handoff summary via
   * mem_session_summary before the new agent's first turn. The run shows in
   * the chat as a normal one (displayText hides the internal prompt).
   */
  private requestHandoffSummary(fromAgentId: string): void {
    const base = this.state.selectedProject();
    if (!base) return;
    const focusedPane = this.state.focusedSessionKey();
    const displayText = this.translate.instant('chat.handoff_request_display') as string;
    void this.api.sendInstruction(
      base,
      buildHandoffRequestPrompt(),
      [],
      'apply',
      displayText,
      focusedPane === null
        ? { agentIdOverride: fromAgentId }
        : { runKey: focusedPane, sessionId: focusedPane, isolate: false, agentIdOverride: fromAgentId },
    );
  }

  // ── Audit Log methods ────────────────────────────────────────────
  async loadAuditLog(): Promise<void> {
    if (this.auditLoaded) return;
    this.auditLoading.set(true);
    try {
      const entries = await this.api.readAuditLog(100);
      this.auditEntries.set(entries);
      this.auditLoaded = true;
    } finally {
      this.auditLoading.set(false);
    }
  }

  formatAuditTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  async exportAuditLog(): Promise<void> {
    // The audit log lives in <userData>/audit.log. We do not have a dedicated
    // `getAuditLogPath()` IPC yet (tracked as a future enhancement), so for
    // now we show the entries count as confirmation that export was triggered.
    // When getAuditLogPath() is added, replace this with api.openPath(path).
    const entries = this.auditEntries();
    if (entries.length === 0) return;
    // Build a simple CSV blob and trigger a download in the renderer.
    const header = 'Time,Agent,Project,Tool';
    const rows = entries.map((e) =>
      [
        new Date(e.ts).toISOString(),
        JSON.stringify(e.agentId),
        JSON.stringify(e.project),
        JSON.stringify(e.tool),
      ].join(','),
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'audit-log.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}

function stableSettingsSnapshot(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
    return Object.keys(nested as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (nested as Record<string, unknown>)[key];
        return acc;
      }, {});
  });
}
