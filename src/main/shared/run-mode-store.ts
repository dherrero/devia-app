import type { RunMode } from '../../shared/domain/run-capabilities';

/** Where a mode change came from, so a listener can skip echoing it back. */
export type RunModeSource = 'desktop' | 'remote' | 'reset';

export type RunModeListener = (project: string, mode: RunMode, source: RunModeSource) => void;

/** A new session starts in plan mode. */
export const DEFAULT_RUN_MODE: RunMode = 'plan';

/**
 * Single source of truth for the run mode of each session (keyed like the run
 * gateway: the project path / session key). The desktop composer and the
 * Telegram router both read and write it, so they always agree. In-memory only:
 * a restart returns every session to {@link DEFAULT_RUN_MODE}.
 */
export class RunModeStore {
  private readonly modes = new Map<string, RunMode>();
  private readonly listeners = new Set<RunModeListener>();

  get(project: string): RunMode {
    return this.modes.get(project) ?? DEFAULT_RUN_MODE;
  }

  /** Sets the mode and notifies listeners only when it actually changed. */
  set(project: string, mode: RunMode, source: RunModeSource): void {
    if (this.get(project) === mode) return;
    if (mode === DEFAULT_RUN_MODE) this.modes.delete(project);
    else this.modes.set(project, mode);
    for (const listener of this.listeners) {
      try {
        listener(project, mode, source);
      } catch {
        /* an observer must never break the mode change */
      }
    }
  }

  /** Every session whose mode differs from the default. */
  entries(): Array<{ project: string; mode: RunMode }> {
    return [...this.modes].map(([project, mode]) => ({ project, mode }));
  }

  /** A fresh session goes back to the default mode. */
  reset(project: string): void {
    this.set(project, DEFAULT_RUN_MODE, 'reset');
  }

  subscribe(listener: RunModeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
