import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import { AppStateService } from './app-state.service';
import { ElectronApiService } from './electron-api.service';
import { ToastService } from './toast.service';
import type { InstalledSkill, McpServerView, SubAgentView } from '../../../types/devia';

/**
 * Per-project asset counts (skills / MCP servers / sub-agents) for the
 * right-rail icon badges.
 *
 * Centralises the data + side effects that used to live in the three
 * sidebar chip components (#269/#274/#275). Counts mirror exactly what
 * the corresponding manager modal shows:
 *  - skills      → all skills available to the project (`listSkills`
 *                  project + global, deduplicated by name). We still keep
 *                  the skill-registry watcher attached so the agent-facing
 *                  `.devia/skill-registry.md` stays fresh (#269).
 *  - mcp         → installed servers (global + project scope).
 *  - sub-agents  → Devia's project sub-agents, with the one-shot
 *                  auto-import scan on project switch.
 *
 * `providedIn: 'root'` so the singleton (and its effects) stay alive
 * across the right-rail mount/unmount that follows project selection.
 */
@Injectable({ providedIn: 'root' })
export class ProjectAssetsService {
  private readonly state = inject(AppStateService);
  private readonly api = inject(ElectronApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly projectSkills = signal<InstalledSkill[]>([]);
  private readonly globalSkills = signal<InstalledSkill[]>([]);
  private readonly _mcpServers = signal<McpServerView[]>([]);
  private readonly subAgents = signal<SubAgentView[]>([]);

  /**
   * Live MCP server catalog (global + project scope). Shared by every UI
   * that needs to resolve `mcp__<serverId>__<tool>` provenance — chiefly
   * `ToolCallCardComponent`. Centralising the subscription here keeps the
   * `mcp:list-changed` listener count constant regardless of how many
   * tool-call cards are mounted (T-73).
   */
  readonly mcpServers = this._mcpServers.asReadonly();

  // All skills available to the project = project + global, deduplicated
  // by name (a skill installed in both scopes counts once).
  readonly skillCount = computed(() => {
    const names = new Set<string>();
    for (const s of this.projectSkills()) names.add(s.name);
    for (const s of this.globalSkills()) names.add(s.name);
    return names.size;
  });
  readonly mcpCount = computed(() => this._mcpServers().length);
  readonly subAgentCount = computed(() => this.subAgents().length);

  constructor() {
    // Project switch: refresh installed skills, (re)attach the skill
    // registry watcher, and fire the idempotent sub-agent auto-import.
    effect(() => {
      const project = this.state.selectedProject();
      // MCP servers are global+project scoped, so the catalog itself is
      // project-independent — but we refresh on every project switch (and on
      // the effect's initial run) so the badge count is reliably populated,
      // mirroring how skills/sub-agents refresh below. A one-shot fetch in the
      // constructor could miss if it raced the registry load on startup.
      void this.refreshMcp();
      if (!project) {
        this.projectSkills.set([]);
        this.globalSkills.set([]);
        this.subAgents.set([]);
        void this.api.skillRegistryWatch(null);
        return;
      }
      // Keep the agent-facing .devia/skill-registry.md fresh (#269).
      void this.api.skillRegistryWatch(project);
      void this.refreshSkills(project);
      void this.api
        .subAgentsAutoImport(project)
        .then((result) => {
          if (result.imported.length > 0) {
            this.toast.show(
              this.translate.instant('sub_agents.badge.auto_import_toast', {
                count: result.imported.length,
              }),
              { kind: 'info', durationMs: 8_000 },
            );
          }
        })
        .finally(() => void this.refreshSubAgents(project));
    });

    this.api.onSubAgentsChanged((e) => {
      if (e.projectPath === this.state.selectedProject()) this.subAgents.set(e.subAgents);
    });

    // Live updates from install/remove (the initial fetch happens in the
    // project-switch effect above). Release the listener on destroy so the
    // contextBridge channel does not accumulate handlers (T-73).
    const unsubscribeMcp = this.api.onMcpListChanged((next) => this._mcpServers.set(next));
    this.destroyRef.onDestroy(unsubscribeMcp);
  }

  /** Re-read installed project skills. Called on project switch and by
   *  the Skills modal after install/remove (the skills manager exposes
   *  no change event, unlike MCP and sub-agents). */
  async refreshSkills(project: string): Promise<void> {
    try {
      const result = await this.api.listSkills(project);
      if (this.state.selectedProject() === project) {
        this.projectSkills.set(result.project);
        this.globalSkills.set(result.global);
      }
    } catch {
      this.projectSkills.set([]);
      this.globalSkills.set([]);
    }
  }

  private async refreshSubAgents(project: string): Promise<void> {
    try {
      const list = await this.api.subAgentsList(project);
      if (this.state.selectedProject() === project) this.subAgents.set(list);
    } catch {
      this.subAgents.set([]);
    }
  }

  private async refreshMcp(): Promise<void> {
    try {
      this._mcpServers.set(await this.api.mcpList());
    } catch {
      this._mcpServers.set([]);
    }
  }
}
