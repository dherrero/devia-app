import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ConfigRepository,
  PinnedStore,
  ProjectRegistry,
  SessionStore,
  StateStore,
} from '../ports';

interface PersistedProject {
  newSession: boolean;
  activeSessionId: string | null;
  agentSessionId?: string | null;
  agentSessionAgentId?: string | null;
}

interface PersistedState {
  pinnedProjects: string[];
  projects: Record<string, PersistedProject>;
}

/**
 * Aggregates state.json: toggles + per-project session metadata + the pinned
 * list. Storage lives next to `devia-app.config.json` (~/.devia-app/) so
 * users can wipe the whole app state by removing one directory.
 */
export class FsStateStore implements StateStore {
  constructor(private readonly deps: {
    config: ConfigRepository;
    registry: ProjectRegistry;
    pinned: PinnedStore;
    sessions: SessionStore;
  }) {}

  private stateFile(): string {
    return path.join(this.deps.config.deviaDir(), 'state.json');
  }

  save(): void {
    const projects: Record<string, PersistedProject> = {};
    for (const [name, record] of this.deps.registry.entries()) {
      projects[name] = {
        newSession: record.newSession,
        activeSessionId: record.activeSessionId,
        agentSessionId: record.agentSessionId,
        agentSessionAgentId: record.agentSessionAgentId,
      };
    }
    const payload: PersistedState = {
      pinnedProjects: this.deps.pinned.list(),
      projects,
    };
    try {
      fs.writeFileSync(this.stateFile(), JSON.stringify(payload, null, 2));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[persistence] save failed:', message);
    }
  }

  load(): void {
    const file = this.stateFile();
    if (!fs.existsSync(file)) return;

    let data: Partial<PersistedState>;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PersistedState>;
    } catch {
      return;
    }

    const { workspaceRoot } = this.deps.config.get();

    // Pinned list: drop entries whose folder no longer exists so the sidebar
    // doesn't render dangling pins after the user deletes a project.
    if (Array.isArray(data.pinnedProjects)) {
      const survivors = data.pinnedProjects.filter((p): p is string =>
        typeof p === 'string'
        && p.length > 0
        && (!workspaceRoot || fs.existsSync(path.join(workspaceRoot, p))),
      );
      this.deps.pinned.set(survivors);
    }

    for (const [name, info] of Object.entries(data.projects ?? {})) {
      if (workspaceRoot && !fs.existsSync(path.join(workspaceRoot, name))) continue;
      const record = this.deps.registry.getOrCreate(name);
      record.newSession = info?.newSession ?? true;
      record.activeSessionId = this.deps.sessions.isValidSessionId(info?.activeSessionId)
        ? info.activeSessionId
        : null;
      // Restore agent-generated session ID. Only set if the agent confirmed it.
      record.agentSessionId = typeof info?.agentSessionId === 'string'
        ? info.agentSessionId
        : null;
      // The agent that owns that session id. Legacy state (pre this field) has
      // no owner → null → resume is skipped until the active agent re-confirms,
      // which is the safe behaviour (never resume another agent's session).
      record.agentSessionAgentId = typeof info?.agentSessionAgentId === 'string'
        ? info.agentSessionAgentId
        : null;
    }
  }
}
