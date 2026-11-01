import type { ProjectRegistry, SessionStore } from './ports';
import type { RunModeStore } from './run-mode-store';

/**
 * Startup restore: put every project back in the run mode its ACTIVE session was
 * left in. Sessions without a stored mode (new, or saved before the field
 * existed) stay on the default. Never throws — a bad session file must not
 * block boot.
 */
export function seedRunModes(
  registry: ProjectRegistry,
  sessions: SessionStore,
  runModes: RunModeStore,
): void {
  for (const [project, record] of registry.entries()) {
    if (!record.activeSessionId) continue;
    try {
      const mode = sessions.load(project, record.activeSessionId)?.runMode;
      if (mode) runModes.set(project, mode, 'restore');
    } catch {
      /* best-effort */
    }
  }
}
