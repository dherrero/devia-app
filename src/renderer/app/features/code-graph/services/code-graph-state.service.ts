import { Injectable, inject, signal } from '@angular/core';

import type { CodeGraphStatus, IndexProgress, ToolUsageSummary } from '../../../../../shared/domain/code-graph';
import { ElectronApiService } from '../../../core/services/electron-api.service';

const DOMAIN_CODES = ['CODE_GRAPH_NOT_CREATED', 'CODE_GRAPH_WATCH_LIMIT'] as const;

const STATE_CHANGING_CODES: readonly string[] = ['CODE_GRAPH_NOT_CREATED'];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Electron wraps IPC rejections ("Error invoking remote method …: Error: CODE"), so codes are matched as substrings. */
function mapError(err: unknown): string {
  const message = messageOf(err);
  return DOMAIN_CODES.find((code) => message.includes(code)) ?? message;
}

/**
 * State of the code graph screen (S-44) for the single project open in /graph.
 *
 * Every async result is guarded by a generation number bumped on each open/close,
 * so a response that arrives after the user switched project (or left the screen)
 * is dropped instead of overwriting the current project's state.
 */
@Injectable({ providedIn: 'root' })
export class CodeGraphStateService {
  private readonly api = inject(ElectronApiService);

  private readonly _status = signal<CodeGraphStatus | null>(null);
  private readonly _progress = signal<IndexProgress | null>(null);
  private readonly _loading = signal(false);
  private readonly _busy = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _project = signal<string | null>(null);
  private readonly _watchUnavailable = signal(false);
  private readonly _usage = signal<ToolUsageSummary | null>(null);

  readonly status = this._status.asReadonly();
  readonly progress = this._progress.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();
  readonly project = this._project.asReadonly();
  readonly watchUnavailable = this._watchUnavailable.asReadonly();
  /** How much the agents have called the graph tools in this project (S-48); null until read. */
  readonly usage = this._usage.asReadonly();

  private generation = 0;
  private current: string | null = null;
  private watching = false;
  private unsubscribers: (() => void)[] = [];

  async open(project: string): Promise<void> {
    void this.teardown();
    const token = this.generation;
    this.current = project;
    this._project.set(project);
    this._loading.set(true);
    this.subscribe();

    try {
      const status = await this.api.codeGraphStatus(project);
      if (token !== this.generation) return;
      this._status.set(status);
    } catch (err) {
      if (token !== this.generation) return;
      this._error.set(mapError(err));
    } finally {
      if (token === this.generation) this._loading.set(false);
    }

    if (token !== this.generation) return;
    this.watching = true;
    try {
      await this.api.codeGraphWatch(project);
    } catch {
      // Live updates are a nicety: at the watch cap (or on any watch failure)
      // the graph still works from explicit status reads.
      if (token === this.generation) this._watchUnavailable.set(true);
    }
  }

  /** Re-reads the agent usage counters; a failure keeps the last value (it is a nicety). */
  async refreshUsage(): Promise<void> {
    const project = this.current;
    const token = this.generation;
    if (project === null) return;
    try {
      const usage = await this.api.codeGraphUsage(project);
      if (token === this.generation) this._usage.set(usage);
    } catch {
      // keep the previous value
    }
  }

  async close(): Promise<void> {
    await this.teardown();
  }

  async index(): Promise<void> {
    await this.runJob((project) => this.api.codeGraphIndex(project), true);
  }

  async update(): Promise<void> {
    await this.runJob((project) => this.api.codeGraphUpdate(project), false);
  }

  async cancel(): Promise<void> {
    await this.run((project) => this.api.codeGraphCancel(project), false);
  }

  async reset(): Promise<void> {
    await this.run((project) => this.api.codeGraphReset(project), true);
  }

  async setAgentAccess(on: boolean): Promise<void> {
    await this.run((project) => this.api.codeGraphSetAgentAccess(project, on), true);
  }

  async setAutoUpdate(on: boolean): Promise<void> {
    await this.run((project) => this.api.codeGraphSetAutoUpdate(project, on), true);
  }

  dismissError(): void {
    this._error.set(null);
  }

  private async runJob(call: (project: string) => Promise<CodeGraphStatus>, optimistic: boolean): Promise<void> {
    const project = this.current;
    if (project === null || this._busy()) return;
    const token = this.generation;
    const before = this._status();
    this._busy.set(true);
    this._error.set(null);
    if (optimistic && before) this._status.set({ ...before, state: 'indexing' });
    try {
      const status = await call(project);
      if (token !== this.generation) return;
      this.applyStatus(status);
    } catch (err) {
      if (token !== this.generation) return;
      this._status.set(before);
      this._error.set(mapError(err));
    } finally {
      if (token === this.generation) this._busy.set(false);
    }
  }

  private async run(call: (project: string) => Promise<void>, refresh: boolean): Promise<void> {
    const project = this.current;
    if (project === null) return;
    const token = this.generation;
    this._error.set(null);
    try {
      await call(project);
      if (!refresh || token !== this.generation) return;
      const status = await this.api.codeGraphStatus(project);
      if (token !== this.generation) return;
      this.applyStatus(status);
    } catch (err) {
      if (token !== this.generation) return;
      const mapped = mapError(err);
      this._error.set(mapped);
      if (STATE_CHANGING_CODES.includes(mapped)) await this.refreshAfterFailure(project, token);
    }
  }

  /** Best-effort: the failure says the graph changed under us (e.g. reset from another window). */
  private async refreshAfterFailure(project: string, token: number): Promise<void> {
    try {
      const status = await this.api.codeGraphStatus(project);
      if (token === this.generation) this.applyStatus(status);
    } catch {
      // Keep the action's error; the next status event or open() will correct the view.
    }
  }

  private applyStatus(status: CodeGraphStatus): void {
    this._status.set(status);
    if (status.state !== 'indexing') this._progress.set(null);
  }

  private subscribe(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers = [
      this.api.onCodeGraphProgress((e) => {
        if (e.project === this.current) this._progress.set(e.progress);
      }),
      this.api.onCodeGraphStatusChanged((e) => {
        if (e.project === this.current) this.applyStatus(e.status);
      }),
    ];
  }

  /** Synchronous reset so a following open() starts clean; resolves once the unwatch settles. */
  private teardown(): Promise<void> {
    this.generation++;
    const previous = this.current;
    const wasWatching = this.watching;
    this.current = null;
    this.watching = false;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this._project.set(null);
    this._status.set(null);
    this._progress.set(null);
    this._loading.set(false);
    this._busy.set(false);
    this._error.set(null);
    this._watchUnavailable.set(false);
    this._usage.set(null);
    if (previous === null || !wasWatching) return Promise.resolve();
    return this.api.codeGraphUnwatch(previous).catch(() => undefined);
  }
}
