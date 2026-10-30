import type {
  ProcessHandle,
  ProcessTrackingRegistry,
} from '../domain/ports';
import type { ProjectRecord } from '../../../shared/ports';
import type { RunId } from '../../../../shared/domain/agent';
import type { CancelReason } from '../../../../shared/domain/agent-event';

interface MutableRecord {
  name: string;
  newSession: boolean;
  activeSessionId: string | null;
  agentSessionId: string | null;
  agentSessionAgentId: string | null;
  handle: ProcessHandle | null;
  /**
   * RunId for the currently-attached process, or null when idle.
   * Added REV-AGENT-CORE-001 — enables targeted cancellation via cancelRun(runId).
   */
  currentRunId: RunId | null;
}

/**
 * `InMemoryProjectRegistry` is the single owner of per-project process state.
 * The shared `ProjectRegistry` port exposes a read-mostly view to other
 * features (workspace, status, persistence); the runner feature uses the
 * richer `ProcessTrackingRegistry` interface to attach/detach handles.
 */
export class InMemoryProjectRegistry implements ProcessTrackingRegistry {
  private readonly records = new Map<string, MutableRecord>();

  private view(record: MutableRecord): ProjectRecord {
    return {
      get name() { return record.name; },
      get isRunning() { return record.handle !== null; },
      get newSession() { return record.newSession; },
      set newSession(v: boolean) { record.newSession = v; },
      get activeSessionId() { return record.activeSessionId; },
      set activeSessionId(v: string | null) { record.activeSessionId = v; },
      get agentSessionId() { return record.agentSessionId; },
      set agentSessionId(v: string | null) { record.agentSessionId = v; },
      get agentSessionAgentId() { return record.agentSessionAgentId; },
      set agentSessionAgentId(v: string | null) { record.agentSessionAgentId = v; },
    };
  }

  private internal(projectPath: string): MutableRecord | undefined {
    return this.records.get(projectPath);
  }

  getOrCreate(projectPath: string): ProjectRecord {
    let record = this.records.get(projectPath);
    if (!record) {
      record = {
        name: projectPath,
        newSession: true,
        activeSessionId: null,
        agentSessionId: null,
        agentSessionAgentId: null,
        handle: null,
        currentRunId: null,
      };
      this.records.set(projectPath, record);
    }
    return this.view(record);
  }

  find(projectPath: string): ProjectRecord | undefined {
    const record = this.records.get(projectPath);
    return record ? this.view(record) : undefined;
  }

  has(projectPath: string): boolean {
    return this.records.has(projectPath);
  }

  delete(projectPath: string): void {
    this.records.delete(projectPath);
  }

  *entries(): IterableIterator<readonly [string, ProjectRecord]> {
    for (const [key, record] of this.records) {
      yield [key, this.view(record)];
    }
  }

  *values(): IterableIterator<ProjectRecord> {
    for (const record of this.records.values()) {
      yield this.view(record);
    }
  }

  paths(): string[] {
    return [...this.records.keys()];
  }

  isRunning(projectPath: string): boolean {
    return this.records.get(projectPath)?.handle !== null && this.records.get(projectPath)?.handle !== undefined;
  }

  runningCount(): number {
    let count = 0;
    for (const r of this.records.values()) if (r.handle) count++;
    return count;
  }

  stopProject(projectPath: string): void {
    const record = this.records.get(projectPath);
    if (record?.handle) {
      // REV-AGENT-CORE-011: every project-level stop is user-initiated.
      try { record.handle.kill('user'); } catch { /* swallow */ }
    }
  }

  stopAll(): string[] {
    const stopped: string[] = [];
    for (const record of this.records.values()) {
      if (!record.handle) continue;
      // REV-AGENT-CORE-011: stop-all is always user-initiated.
      try { record.handle.kill('user'); } catch { /* swallow */ }
      stopped.push(record.name);
    }
    return stopped;
  }

  renamePrefix(fromPath: string, toPath: string): void {
    const prefix = fromPath + '/';
    for (const [key, record] of [...this.records.entries()]) {
      if (key !== fromPath && !key.startsWith(prefix)) continue;
      const next = key === fromPath ? toPath : `${toPath}/${key.slice(prefix.length)}`;
      this.records.delete(key);
      record.name = next;
      this.records.set(next, record);
    }
  }

  deletePrefix(folderPath: string): string[] {
    const prefix = folderPath + '/';
    const removed: string[] = [];
    for (const key of [...this.records.keys()]) {
      if (key === folderPath || key.startsWith(prefix)) {
        this.records.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  attachProcess(projectPath: string, handle: ProcessHandle, runId?: RunId): void {
    const record = this.internal(projectPath);
    if (record) {
      record.handle = handle;
      record.currentRunId = runId ?? null;
    }
  }

  detachProcess(projectPath: string): void {
    const record = this.internal(projectPath);
    if (record) {
      record.handle = null;
      record.currentRunId = null;
    }
  }

  writeToolResult(projectPath: string, toolUseId: string, content: string): void {
    const record = this.internal(projectPath);
    if (!record?.handle) return;
    record.handle.writeToolResult?.(toolUseId, content);
  }

  /**
   * Cancel a specific run by id. Iterates every project record and SIGTERMs
   * the one whose `currentRunId` matches. Silent no-op if no project owns
   * the runId (e.g. the run already terminated).
   *
   * Idempotent: after the first call the `currentRunId` is cleared so a
   * second call with the same id is a true no-op even if `detachProcess`
   * has not yet run.
   */
  cancelRun(runId: RunId, reason: CancelReason = 'user'): void {
    for (const record of this.records.values()) {
      if (record.currentRunId === runId && record.handle) {
        // REV-AGENT-CORE-011: forward the cancellation cause so the renderer
        // can pick the right system message wording / Retry button.
        try { record.handle.kill(reason); } catch { /* swallow — process may already be gone */ }
        record.currentRunId = null;
        return;
      }
    }
  }
}
