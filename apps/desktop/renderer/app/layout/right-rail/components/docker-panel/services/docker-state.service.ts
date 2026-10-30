import { Injectable, inject, signal } from '@angular/core';

import { ElectronApiService } from '../../../../../core/services/electron-api.service';

export type ComposeAction = 'deploy' | 'down' | 'logs';

interface DockerProjectState {
  readonly log: string;
  readonly running: ComposeAction | null;
  readonly exitCode: number | null;
  /** Project-relative compose file in use (root name or nested path), or null. */
  readonly composeFile: string | null;
  /** Root detection has completed for this project. */
  readonly detected: boolean;
  /** A deep search has been run (so "none found" is distinguishable). */
  readonly searched: boolean;
  /** A deep search is in flight. */
  readonly searching: boolean;
}

const EMPTY: DockerProjectState = {
  log: '', running: null, exitCode: null,
  composeFile: null, detected: false, searched: false, searching: false,
};

const ACTION_LABEL: Record<ComposeAction, string> = {
  deploy: 'up -d --build',
  down: 'down',
  logs: 'logs --tail 50',
};

/**
 * Per-project Docker Compose log + run state for the right-rail panel.
 *
 * Subscribes ONCE (root singleton) to the compose stream events so the
 * panel can mount/unmount with the rail without leaking IPC listeners.
 * Also owns the per-project compose-file detection that gates the run
 * actions: no compose file → buttons disabled + an explanatory message.
 */
@Injectable({ providedIn: 'root' })
export class DockerStateService {
  private readonly api = inject(ElectronApiService);

  private readonly states = signal<Map<string, DockerProjectState>>(new Map());

  constructor() {
    this.api.onComposeStart((e) => {
      this.append(e.project, `$ docker compose ${ACTION_LABEL[e.action as ComposeAction]}\n`, {
        running: e.action as ComposeAction,
        exitCode: null,
      });
    });
    this.api.onComposeOutput((e) => this.append(e.project, e.chunk));
    this.api.onComposeEnd((e) => {
      const tail = e.error ? `\n✖ ${e.error}\n` : `\n— exit ${e.code ?? '?'} —\n`;
      this.append(e.project, tail, { running: null, exitCode: e.code });
    });
  }

  /** Reactive accessor for a project's Docker state (or the empty state). */
  state(project: string): DockerProjectState {
    return this.states().get(project) ?? EMPTY;
  }

  /** Check the project root for a compose file. Idempotent per project. */
  async detect(project: string): Promise<void> {
    const cur = this.states().get(project);
    if (cur?.detected) return;
    try {
      const { file } = await this.api.composeDetect(project);
      this.patchFrom(project, { composeFile: file, detected: true });
    } catch {
      this.patchFrom(project, { detected: true });
    }
  }

  /** Deep-scan the project for compose files in subfolders, on user request. */
  async search(project: string): Promise<void> {
    this.patchFrom(project, { searching: true });
    try {
      const { files } = await this.api.composeSearch(project);
      this.patchFrom(project, {
        searching: false,
        searched: true,
        composeFile: files[0] ?? null,
      });
    } catch {
      this.patchFrom(project, { searching: false, searched: true });
    }
  }

  run(project: string, action: ComposeAction): void {
    const file = this.states().get(project)?.composeFile ?? undefined;
    this.api.runCompose(project, action, file);
  }

  clear(project: string): void {
    this.patchFrom(project, { log: '', running: null, exitCode: null });
  }

  private append(project: string, chunk: string, extra?: Partial<DockerProjectState>): void {
    const cur = this.states().get(project) ?? EMPTY;
    this.patchFrom(project, { ...extra, log: cur.log + chunk });
  }

  private patchFrom(project: string, patch: Partial<DockerProjectState>): void {
    const cur = this.states().get(project) ?? EMPTY;
    const map = new Map(this.states());
    map.set(project, { ...cur, ...patch });
    this.states.set(map);
  }
}
