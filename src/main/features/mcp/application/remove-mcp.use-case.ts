import * as os from 'node:os';
import * as path from 'node:path';

import type {
  McpAgentId,
  McpInstallResult,
  McpServerConfig,
} from '../../../../shared/domain/mcp';
import { McpServerRegistry } from '../domain/registry';
import { targetsForServer } from '../domain/agent-targets';
import { McpSyncWriter } from '../infrastructure/mcp-sync-writer';
import { writeRegistry } from '../infrastructure/source-of-truth';
import { revokeClaudeMcpAccess } from '../../../shared/claude-defaults';
import type { SnapshotCapturer } from '../../../shared/ports';

/**
 * Remove an MCP server from the Devia catalog and every agent file
 * it was synchronised to (#272).
 */
export class RemoveMcpUseCase {
  constructor(
    private readonly registry: McpServerRegistry,
    private readonly writer: McpSyncWriter,
    private readonly deviaDir: () => string,
    private readonly snapshot?: SnapshotCapturer,
  ) {}

  execute(id: string, projectPath?: string): McpInstallResult {
    const server = this.registry.get(id);
    if (!server) return { ok: false, affectedFiles: [], error: `Servidor "${id}" no encontrado` };

    const scope = server.scope ?? 'global';
    const agents = server.agents ?? ['claude'];
    const ctx = { home: os.homedir(), ...(projectPath !== undefined && { project: projectPath }) };
    const targets = targetsForServer(agents, scope, ctx);

    const affectedFiles = Array.from(new Set(
      targets.flatMap(({ target, agent }) => this.writer.pathsToTouch({
        agent,
        target,
        managed: [],
        removedIds: [id],
        parentEnv: process.env,
      })),
    ));

    let snapshotId: string | undefined;
    if (this.snapshot && affectedFiles.length > 0) {
      try {
        const snap = this.snapshot.execute({
          feature: 'mcp',
          reason: `mcp:remove "${id}" from ${agents.join('+')}`,
          paths: affectedFiles,
          ...(projectPath !== undefined && { projectPath }),
        });
        snapshotId = snap.id;
      } catch (err) {
        console.warn('[mcp:remove] snapshot skipped:', (err as Error).message);
      }
    }

    this.registry.remove(id);

    // Persist + sync. Same grouping as install: each agent file is
    // rewritten with the remaining managed servers for that scope.
    const remaining = this.registry.all().filter(
      (s) => (s.scope ?? 'global') === scope && s.enabled,
    );
    const file = scope === 'project' && projectPath
      ? path.join(projectPath, '.devia', 'mcp-servers.json')
      : path.join(this.deviaDir(), 'mcp-servers.json');
    writeRegistry(file, this.registry.all().filter((s) => (s.scope ?? 'global') === scope));

    const byAgent = new Map<McpAgentId, McpServerConfig[]>();
    for (const s of remaining) {
      for (const a of s.agents ?? ['claude']) {
        const list = byAgent.get(a) ?? [];
        list.push(s);
        byAgent.set(a, list);
      }
    }

    const failed: string[] = [];
    // Ensure every agent the removed server lived under gets a fresh
    // write so its old entry actually leaves the file.
    for (const a of agents) {
      const target = targetsForServer([a], scope, ctx)[0]?.target;
      if (!target) continue;
      try {
        this.writer.write({
          agent: a,
          target,
          managed: byAgent.get(a) ?? [],
          removedIds: [id],
          parentEnv: process.env,
        });
      } catch (err) {
        failed.push(`${a}: ${(err as Error).message}`);
      }
    }

    // Strip the Claude tool permission / `.mcp.json` trust grant written at
    // install time (project scope only — global grants are written per-project
    // by the runner and are harmless leftovers).
    if (scope === 'project' && projectPath && agents.includes('claude')) {
      try {
        revokeClaudeMcpAccess(projectPath, [id]);
      } catch (err) {
        console.warn('[mcp:remove] could not revoke Claude MCP permission:', (err as Error).message);
      }
    }

    return {
      ok: failed.length === 0,
      affectedFiles,
      ...(snapshotId !== undefined && { snapshotId }),
      ...(failed.length > 0 && { error: failed.join('; ') }),
    };
  }
}
