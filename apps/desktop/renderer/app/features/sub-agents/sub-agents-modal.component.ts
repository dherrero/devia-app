import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LucideUsers, LucideStore, LucideSlidersHorizontal, LucideTrash2, LucideWrench, LucidePlus,
  LucideSave,
} from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import {
  ButtonComponent, CheckboxComponent, DIALOG_DATA, DialogRef, DialogService, IconComponent,
  InputComponent, SpinnerComponent, TextareaComponent,
  TooltipDirective,
} from '@devia/ui';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { ToastService } from '../../core/services/toast.service';
import { ModalShellComponent, type ModalNavSection } from '../../shared/components/modal-shell/modal-shell.component';
import { SUB_AGENT_CATALOG } from './catalog';
import type {
  SubAgentCatalogEntry,
  SubAgentCliId,
  SubAgentView,
} from '../../../types/devia';

/**
 * Sub-agent manager modal (#275). Three tabs:
 *   - Project sub-agents — installed entries with per-CLI matrix.
 *   - Catálogo — Devia-curated quick installs.
 *   - Personalizado — manual form with description + body + tools.
 *
 * Each install / remove goes through the main process which captures
 * a pre-write snapshot (#270). The modal subscribes to
 * `subAgents:changed` so other windows / paths stay in sync.
 */

export interface SubAgentsModalData {
  projectPath: string;
}

const ALL_CLIS: ReadonlyArray<{ id: SubAgentCliId; label: string; supported: boolean }> = [
  { id: 'claude',       label: 'Claude Code',       supported: true  },
  { id: 'cursor-agent', label: 'Cursor Agent',      supported: true  },
  { id: 'gemini',       label: 'Gemini CLI',        supported: true  },
  { id: 'opencode',     label: 'OpenCode',          supported: true  },
  { id: 'qwen',         label: 'Qwen Code',         supported: true  },
  { id: 'copilot',      label: 'GitHub Copilot',    supported: true  },
  { id: 'codex',        label: 'Codex (solo-agent)', supported: false },
];

const AVATAR_COLORS = [
  'oklch(55% 0.20 280)',
  'oklch(52% 0.18 145)',
  'oklch(68% 0.16 80)',
  'oklch(58% 0.19 25)',
  'oklch(55% 0.18 200)',
  'oklch(55% 0.20 320)',
  'oklch(55% 0.18 240)',
  'oklch(52% 0.14 60)',
] as const;
interface CustomFormState {
  name: string;
  description: string;
  toolsText: string;
  body: string;
  agents: Set<SubAgentCliId>;
}

@Component({
  selector: 'ds-sub-agents-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonComponent, CheckboxComponent, IconComponent, InputComponent, SpinnerComponent, TextareaComponent,
    TooltipDirective, TranslateModule, ModalShellComponent,
  ],
  templateUrl: './sub-agents-modal.component.html',
  styleUrl: './sub-agents-modal.component.scss',
})
export class SubAgentsModalComponent {
  private readonly api = inject(ElectronApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialogs = inject(DialogService);
  readonly data = inject<SubAgentsModalData>(DIALOG_DATA);
  readonly ref = inject(DialogRef, { optional: true });

  readonly LucideUsers = LucideUsers;
  readonly LucideStore = LucideStore;
  readonly LucideSlidersHorizontal = LucideSlidersHorizontal;
  readonly LucideTrash2 = LucideTrash2;
  readonly LucideWrench = LucideWrench;
  readonly LucidePlus = LucidePlus;
  readonly LucideSave = LucideSave;

  readonly allClis = ALL_CLIS;
  readonly catalog = SUB_AGENT_CATALOG;

  readonly loading = signal<boolean>(true);
  readonly installing = signal<boolean>(false);
  readonly active = signal<string>('project');
  readonly sections = computed<ModalNavSection[]>(() => [
    { id: 'project', label: this.translate.instant('sub_agents.modal.tab_project'), icon: LucideUsers },
    { id: 'catalog', label: this.translate.instant('sub_agents.modal.tab_catalog'), icon: LucideStore },
    { id: 'custom', label: this.translate.instant('sub_agents.modal.tab_custom'), icon: LucideSlidersHorizontal },
  ]);
  readonly entries = signal<SubAgentView[]>([]);

  readonly form = signal<CustomFormState>(emptyForm());

  readonly canSaveCustom = computed(() => {
    const f = this.form();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.name)
      && f.body.trim().length > 0
      && f.agents.size > 0;
  });

  constructor() {
    void this.refresh();
    this.api.onSubAgentsChanged((e) => {
      if (e.projectPath === this.data.projectPath) {
        this.entries.set(e.subAgents);
      }
    });
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      // Always run auto-import first: covers the case where the user
      // clicks the right-rail button on a project that has native
      // sub-agents (e.g. .claude/agents/) but Devia hasn't imported
      // them yet. Auto-import is idempotent and safe to call on
      // every refresh.
      await this.api.subAgentsAutoImport(this.data.projectPath).catch(() => {
        /* best-effort — keep loading even when auto-import fails */
      });
      const list = await this.api.subAgentsList(this.data.projectPath);
      this.entries.set(list);
    } finally {
      this.loading.set(false);
    }
  }

  async toggleAgent(view: SubAgentView, cli: SubAgentCliId): Promise<void> {
    if (!ALL_CLIS.find((c) => c.id === cli)?.supported) return;
    const next = view.agents.includes(cli)
      ? view.agents.filter((a) => a !== cli)
      : [...view.agents, cli];
    const result = await this.api.subAgentsInstall(this.data.projectPath, {
      name: view.name,
      description: view.description,
      tools: [...view.tools],
      agents: next,
      body: '', // will be re-read from disk by the main process
      ...(view.model !== undefined && { model: view.model }),
      ...(view.readonly !== undefined && { readonly: view.readonly }),
    });
    if (!result.ok) {
      this.toast.show(result.error ?? 'Error', { kind: 'error' });
    }
  }

  async remove(view: SubAgentView): Promise<void> {
    const ok = await firstValueFrom(
      this.dialogs.confirm({
        title: this.translate.instant('sub_agents.modal.remove_confirm_title'),
        message: this.translate.instant('sub_agents.modal.remove_confirm_message', { name: view.name }),
        confirmLabel: this.translate.instant('sub_agents.modal.remove'),
        cancelLabel: this.translate.instant('common.cancel'),
        danger: true,
      }),
    );
    if (!ok) return;
    const result = await this.api.subAgentsRemove(this.data.projectPath, view.name);
    if (result.ok) {
      this.toast.show(this.translate.instant('sub_agents.modal.remove_ok'), { kind: 'success' });
    } else {
      this.toast.show(result.error ?? 'Error', { kind: 'error' });
    }
  }

  installFromCatalog(entry: SubAgentCatalogEntry): void {
    this.form.set({
      name: entry.slug,
      description: entry.description,
      toolsText: entry.tools.join(', '),
      body: entry.body,
      agents: new Set(entry.defaultAgents),
    });
    this.active.set('custom');
  }

  agentInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  avatarColor(name: string): string {
    let hash = 5381;
    for (let i = 0; i < name.length; i += 1) {
      hash = (hash << 5) + hash + name.charCodeAt(i);
      hash &= hash;
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }
  toggleFormAgent(cli: SubAgentCliId, checked: boolean): void {
    const next = new Set(this.form().agents);
    if (checked) next.add(cli); else next.delete(cli);
    this.form.update((f) => ({ ...f, agents: next }));
  }

  updateFormText(key: 'name' | 'description' | 'toolsText' | 'body', value: string): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  async installCustom(): Promise<void> {
    const f = this.form();
    this.installing.set(true);
    try {
      const result = await this.api.subAgentsInstall(this.data.projectPath, {
        name: f.name,
        description: f.description,
        tools: f.toolsText.split(',').map((t) => t.trim()).filter(Boolean),
        agents: Array.from(f.agents),
        body: f.body,
      });
      if (result.ok) {
        this.toast.show(this.translate.instant('sub_agents.modal.install_ok'), { kind: 'success' });
        this.form.set(emptyForm());
        this.active.set('project');
      } else {
        this.toast.show(result.error ?? 'Error', { kind: 'error' });
      }
    } finally {
      this.installing.set(false);
    }
  }
}

function emptyForm(): CustomFormState {
  return {
    name: '',
    description: '',
    toolsText: '',
    body: '',
    agents: new Set<SubAgentCliId>(['claude']),
  };
}
