import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  McpAgentId,
  McpInstallResult,
  McpScope,
  McpServerConfig,
  McpSource,
} from '../../../../shared/domain/mcp';
import { McpServerRegistry } from '../domain/registry';
import { validateServerConfig } from '../domain/validate';
import { targetsForServer } from '../domain/agent-targets';
import { McpSyncWriter, type SyncTargetInput } from '../infrastructure/mcp-sync-writer';
import { writeRegistry } from '../infrastructure/source-of-truth';
import { grantClaudeMcpAccess } from '../../../shared/claude-defaults';
import type { SnapshotCapturer } from '../../../shared/ports';

/**
 * Add or update an MCP server in the Devia catalog and materialise
 * it into every selected agent's config file (#272).
 *
 *   1. Validate the requested config (sanitises command / env keys).
 *   2. Snapshot the affected target files (when wired).
 *   3. Upsert into the registry + persist the source-of-truth file.
 *   4. Sync to each agent file via the per-agent writer.
 */

export interface InstallMcpRequest {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  allowedEnvKeys?: string[];
  agents: McpAgentId[];
  scope: McpScope;
  source: McpSource;
  /** Absolute project path — required when `scope === 'project'`. */
  projectPath?: string;
  /** Defaults to true. Honoured when present. */
  enabled?: boolean;
}

export class InstallMcpUseCase {
  constructor(
    private readonly registry: McpServerRegistry,
    private readonly writer: McpSyncWriter,
    private readonly deviaDir: () => string,
    private readonly snapshot?: SnapshotCapturer,
  ) {}

  execute(req: InstallMcpRequest): McpInstallResult {
    // 1. Validate the incoming shape.
    const candidate: Partial<McpServerConfig> = {
      id: req.id,
      name: req.name,
      command: req.command,
      args: req.args,
      enabled: req.enabled !== false,
      agents: req.agents,
      scope: req.scope,
      source: req.source,
      createdAt: Date.now(),
      pinned: false,
      ...(req.description !== undefined && { description: req.description }),
      ...(req.env !== undefined && { env: req.env }),
      ...(req.allowedEnvKeys !== undefined && { allowedEnvKeys: req.allowedEnvKeys }),
    };
    const validated = validateServerConfig(candidate);
    if (!validated) {
      return { ok: false, affectedFiles: [], error: 'Configuración inválida' };
    }
    if (req.scope === 'project' && !req.projectPath) {
      return { ok: false, affectedFiles: [], error: 'projectPath requerido para scope=project' };
    }

    // 2. Resolve per-agent targets + snapshot the files we'll touch.
    const ctx = { home: os.homedir(), ...(req.projectPath !== undefined && { project: req.projectPath }) };
    const targets = targetsForServer(validated.agents ?? ['claude'], req.scope, ctx);
    const affectedFiles = Array.from(new Set(
      targets.flatMap(({ target, agent }) => this.writer.pathsToTouch({
        agent,
        target,
        managed: [validated],
        parentEnv: process.env,
      })),
    ));

    let snapshotId: string | undefined;
    if (this.snapshot && affectedFiles.length > 0) {
      try {
        const snap = this.snapshot.execute({
          feature: 'mcp',
          reason: `mcp:install "${validated.id}" for ${(validated.agents ?? []).join('+')}`,
          paths: affectedFiles,
          ...(req.projectPath !== undefined && { projectPath: req.projectPath }),
        });
        snapshotId = snap.id;
      } catch (err) {
        console.warn('[mcp:install] snapshot skipped:', (err as Error).message);
      }
    }

    // 3. Upsert + persist the Devia source of truth. Project-scope
    //    entries live inside the project tree; global ones in
    //    ~/.devia-app/mcp-servers.json.
    const previous = this.registry.get(validated.id);
    const merged: McpServerConfig = {
      ...validated,
      // Keep createdAt stable across re-installs.
      ...(previous?.createdAt !== undefined && { createdAt: previous.createdAt }),
      ...(previous?.pinned !== undefined && { pinned: previous.pinned }),
    };
    this.registry.upsert(merged);

    // Persist all entries for the matching scope. Project-scope state
    // lives under the project so it travels with the repo.
    const allServers = this.registry.all();
    const file = req.scope === 'project' && req.projectPath
      ? path.join(req.projectPath, '.devia', 'mcp-servers.json')
      : path.join(this.deviaDir(), 'mcp-servers.json');
    writeRegistry(file, allServers.filter((s) => (s.scope ?? 'global') === req.scope));

    // 4. Synchronise each agent file.
    const syncedServers = allServers.filter(
      (s) => (s.scope ?? 'global') === req.scope && s.enabled,
    );
    // Group by agent so each target file is written once with every
    // server belonging to that agent.
    const byAgent = new Map<McpAgentId, McpServerConfig[]>();
    for (const s of syncedServers) {
      for (const agentId of s.agents ?? ['claude']) {
        const list = byAgent.get(agentId) ?? [];
        list.push(s);
        byAgent.set(agentId, list);
      }
    }
    const failed: string[] = [];
    for (const [agent, servers] of byAgent.entries()) {
      const target = targetsForServer([agent], req.scope, ctx)[0]?.target;
      if (!target) continue;
      const input: SyncTargetInput = {
        agent,
        target,
        managed: servers,
        parentEnv: process.env,
      };
      try {
        this.writer.write(input);
      } catch (err) {
        failed.push(`${agent}: ${(err as Error).message}`);
      }
    }

    // Persist the Claude tool permission so the headless `-p` runtime can use
    // the server without a prompt. Project-scope servers load from the project
    // `.mcp.json`, so they also need `enabledMcpjsonServers` trust; global-scope
    // servers are delivered via `--mcp-config` at run time and get their
    // permission written by the runner (RunInstructionUseCase).
    if (req.scope === 'project' && req.projectPath && (validated.agents ?? []).includes('claude')) {
      try {
        grantClaudeMcpAccess(req.projectPath, [validated.id], { trustProjectMcpjson: true });
      } catch (err) {
        console.warn('[mcp:install] could not persist Claude MCP permission:', (err as Error).message);
      }
    }

    return {
      ok: failed.length === 0,
      affectedFiles,
      ...(snapshotId !== undefined && { snapshotId }),
      ...(failed.length > 0 && { error: failed.join('; ') }),
    };
  }

  // Used by RemoveMcpUseCase to share the resolution logic.
  static resolveProjectFile(deviaDir: string, projectPath: string | undefined, scope: McpScope): string {
    if (scope === 'project' && projectPath) {
      return path.join(projectPath, '.devia', 'mcp-servers.json');
    }
    return path.join(deviaDir, 'mcp-servers.json');
  }
}

/** Exposed for the renderer too — the modal precomputes affected
 *  files for the confirm dialog. */
export function affectedFilesFor(req: InstallMcpRequest, writer: McpSyncWriter): string[] {
  const ctx = { home: os.homedir(), ...(req.projectPath !== undefined && { project: req.projectPath }) };
  const targets = targetsForServer(req.agents, req.scope, ctx);
  const dummy: McpServerConfig = {
    id: req.id,
    name: req.name,
    command: req.command,
    args: req.args,
    enabled: req.enabled !== false,
    agents: req.agents,
    scope: req.scope,
    source: req.source,
  };
  return Array.from(new Set(
    targets.flatMap(({ target, agent }) => writer.pathsToTouch({
      agent,
      target,
      managed: [dummy],
      parentEnv: process.env,
    })),
  ));
}

/** Defensive check the IPC handler uses before invoking the use
 *  case — keeps a 1-line guard out of the use-case body. */
export function ensureProjectExists(projectPath: string | undefined): boolean {
  if (!projectPath) return true;
  try { return fs.statSync(projectPath).isDirectory(); } catch { return false; }
}
