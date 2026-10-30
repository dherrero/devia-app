import type { ProjectTech } from './tech-catalog';

export type { ProjectTech };

export interface ProjectEntry {
  /** Leaf name, for display. */
  name: string;
  /** Path relative to workspaceRoot — unique ID across the app. */
  path: string;
  isRunning: boolean;
  tech: ProjectTech;
}

export interface PinnedEntry {
  path: string;
  tech: ProjectTech;
  isRunning: boolean;
}
