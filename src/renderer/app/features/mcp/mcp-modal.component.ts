import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LucideZap, LucideNetwork, LucideStore, LucideSlidersHorizontal, LucidePlus,
} from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import {
  ButtonComponent, DIALOG_DATA, DialogRef, DialogService, IconComponent,
} from '@devia/ui';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { ToastService } from '../../core/services/toast.service';
import { ModalShellComponent, type ModalNavSection } from '../../shared/components/modal-shell/modal-shell.component';
import { MCP_CATALOG } from './catalog';
import { ALL_AGENTS, emptyForm, parseEnv, type FormState, type McpInstallRequest } from './models/mcp-form.model';
import { McpInstalledTabComponent } from './components/mcp-installed-tab/mcp-installed-tab.component';
import { McpCatalogTabComponent } from './components/mcp-catalog-tab/mcp-catalog-tab.component';
import { McpCustomFormComponent } from './components/mcp-custom-form/mcp-custom-form.component';
import type {
  McpCatalogEntry,
  McpInstallResult,
  McpServerView,
} from '../../../types/devia';

/**
 * MCP server manager modal (#273).
 *
 * Three tabs mirroring the skills modal pattern:
 *   - Instaladas - list with per-agent chips + probe / remove.
 *   - Catálogo   - Devia-curated catalog (8 stdio servers).
 *   - Personalizada - manual command + args + env form.
 *
 * The parent owns the shell wiring, the servers list (refresh + live
 * mcp-list-changed subscription) and the install/remove IPC
 * orchestration; each tab body lives in its own subcomponent.
 */

export interface McpModalData {
  /** Active project path (when one is selected). Used for project-
   *  scope installs. Empty string disables the scope toggle. */
  projectPath: string;
}

@Component({
  selector: 'ds-mcp-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent, IconComponent,
    TranslateModule, ModalShellComponent,
    McpInstalledTabComponent, McpCatalogTabComponent, McpCustomFormComponent,
  ],
  templateUrl: './mcp-modal.component.html',
  styleUrl: './mcp-modal.component.scss',
})
export class McpModalComponent {
  private readonly api = inject(ElectronApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialogs = inject(DialogService);
  private readonly destroyRef = inject(DestroyRef);
  readonly data = inject<McpModalData>(DIALOG_DATA);
  readonly ref = inject(DialogRef, { optional: true });

  readonly LucideZap = LucideZap;
  readonly LucidePlus = LucidePlus;

  readonly catalog = MCP_CATALOG;

  readonly loading = signal<boolean>(true);
  readonly installing = signal<boolean>(false);
  readonly active = signal<string>('installed');
  readonly sections = computed<ModalNavSection[]>(() => [
    { id: 'installed', label: this.translate.instant('mcp.modal.tab_installed'), icon: LucideNetwork },
    { id: 'catalog', label: this.translate.instant('mcp.modal.tab_catalog'), icon: LucideStore },
    { id: 'custom', label: this.translate.instant('mcp.modal.tab_custom'), icon: LucideSlidersHorizontal },
  ]);
  readonly servers = signal<McpServerView[]>([]);

  readonly form = signal<FormState>(emptyForm(this.data.projectPath));

  readonly canInstallCustom = computed(() => {
    const f = this.form();
    return f.id.length > 0
      && f.name.length > 0
      && f.command.length > 0
      && f.agents.size > 0;
  });

  constructor() {
    void this.refresh();
    const unsubscribeMcp = this.api.onMcpListChanged((next) => this.servers.set(next));
    this.destroyRef.onDestroy(unsubscribeMcp);
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const list = await this.api.mcpList();
      this.servers.set(list);
    } finally {
      this.loading.set(false);
    }
  }

  async remove(server: McpServerView): Promise<void> {
    const ok = await firstValueFrom(
      this.dialogs.confirm({
        title: this.translate.instant('mcp.modal.remove_confirm_title'),
        message: this.translate.instant('mcp.modal.remove_confirm_message', { name: server.name }),
        confirmLabel: this.translate.instant('mcp.modal.remove'),
        cancelLabel: this.translate.instant('common.cancel'),
        danger: true,
      }),
    );
    if (!ok) return;
    const result = await this.api.mcpRemove(
      server.id,
      server.scope === 'project' ? this.data.projectPath : undefined,
    );
    if (result.ok) {
      this.toast.show(this.translate.instant('mcp.modal.remove_ok'), { kind: 'success' });
      await this.refresh();
    } else {
      this.toast.show(result.error ?? 'Error', { kind: 'error' });
    }
  }

  openCatalogInstall(entry: McpCatalogEntry): void {
    const requiredEnvKeys = entry.requiredEnvKeys ?? [];
    this.form.set({
      id: entry.slug,
      name: entry.name,
      description: entry.description,
      command: entry.command,
      argsText: entry.args.join(' '),
      envText: requiredEnvKeys.map((k) => `${k}=`).join('\n'),
      agents: new Set(entry.defaultAgents ?? ALL_AGENTS.map((a) => a.id)),
      scope: 'global',
      source: entry.source,
      requiredEnv: Object.fromEntries(requiredEnvKeys.map((k) => [k, ''])),
      requiredEnvKeys,
    });
    this.active.set('custom');
  }

  async installCustom(): Promise<void> {
    const f = this.form();
    const env = parseEnv(f.envText);
    const request: McpInstallRequest = {
      id: f.id,
      name: f.name,
      ...(f.description !== '' && { description: f.description }),
      command: f.command,
      args: f.argsText.trim().length === 0 ? [] : f.argsText.trim().split(/\s+/),
      ...(env !== null && { env }),
      agents: Array.from(f.agents),
      scope: f.scope,
      source: f.source,
      ...(f.scope === 'project' && this.data.projectPath !== '' && {
        projectPath: this.data.projectPath,
      }),
    };
    this.installing.set(true);
    try {
      const result = await this.api.mcpInstall(request);
      if (result.ok) {
        this.toast.show(this.translate.instant('mcp.modal.install_ok'), { kind: 'success' });
        this.form.set(emptyForm(this.data.projectPath));
        this.active.set('installed');
        await this.refresh();
      } else {
        logMcpInstallFailure(request, result);
        this.toast.show(result.error ?? 'Error', { kind: 'error' });
      }
    } catch (error) {
      logMcpInstallException(request, error);
      const message = error instanceof Error ? error.message : String(error);
      this.toast.show(message, { kind: 'error' });
    } finally {
      this.installing.set(false);
    }
  }
}

function logMcpInstallFailure(request: McpInstallRequest, result: McpInstallResult): void {
  console.error('[mcp:install] failed', {
    request: sanitizeMcpInstallRequest(request),
    result,
  });
}

function logMcpInstallException(request: McpInstallRequest, error: unknown): void {
  console.error('[mcp:install] threw', {
    request: sanitizeMcpInstallRequest(request),
    error,
  });
}

function sanitizeMcpInstallRequest(request: McpInstallRequest): Omit<McpInstallRequest, 'env'> & { envKeys?: string[] } {
  const { env, ...rest } = request;
  return {
    ...rest,
    ...(env !== undefined && { envKeys: Object.keys(env) }),
  };
}
