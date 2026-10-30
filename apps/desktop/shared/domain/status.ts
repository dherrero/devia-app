import type { GitInfo } from './git';

export interface StatusProjectEntry {
  name: string;
  isRunning: boolean;
  newSession: boolean;
  git: GitInfo | null;
}

export interface StatusInfo {
  runningCount: number;
  projects: StatusProjectEntry[];
}
