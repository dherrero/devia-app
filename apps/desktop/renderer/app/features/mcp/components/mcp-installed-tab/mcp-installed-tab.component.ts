import {
  ChangeDetectionStrategy, Component, computed, inject, input, output, signal,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { LucidePlay, LucidePlus, LucideTrash2 } from '@lucide/angular';
import { ButtonComponent, IconComponent, SpinnerComponent } from '@devia/ui';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import { ALL_AGENTS } from '../../models/mcp-form.model';
import type { McpAgentId, McpProbeResult, McpServerView } from '../../../../../types/devia';

/**
 * "Instaladas" tab: project/global server sidebar + detail panel with
 * per-agent chips, probe and remove. Probe results live in tab-local
 * state - reopening the modal forgets them. The user clicks "Probar"
 * explicitly so opening the modal doesn't fork N child processes.
 */
@Component({
  selector: 'ds-mcp-installed-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, SpinnerComponent, TranslateModule],
  templateUrl: './mcp-installed-tab.component.html',
  styleUrl: './mcp-installed-tab.component.scss',
})
export class McpInstalledTabComponent {
  private readonly api = inject(ElectronApiService);

  readonly LucidePlay = LucidePlay;
  readonly LucidePlus = LucidePlus;
  readonly LucideTrash2 = LucideTrash2;

  readonly servers = input.required<McpServerView[]>();
  readonly loading = input.required<boolean>();

  readonly removeRequested = output<McpServerView>();
  readonly addRequested = output<void>();

  readonly selectedServerId = signal<string | null>(null);
  readonly projectServers = computed(() => this.servers().filter((s) => s.scope === 'project'));
  readonly globalServers = computed(() => this.servers().filter((s) => s.scope === 'global'));
  readonly selectedServer = computed(() => {
    const all = this.servers();
    if (all.length === 0) return null;
    return all.find((server) => server.id === this.selectedServerId()) ?? all[0];
  });
  readonly probeResults = signal<Record<string, McpProbeResult>>({});

  agentLabel(id: McpAgentId): string {
    return ALL_AGENTS.find((a) => a.id === id)?.label ?? id;
  }

  async probe(server: McpServerView): Promise<void> {
    const result = await this.api.mcpProbe(server.id);
    this.probeResults.update((r) => ({ ...r, [server.id]: result }));
  }
}
