export interface PtySize {
  cols: number;
  rows: number;
}

export interface PtyStartResult {
  pid: number;
  cwd: string;
  shell: string;
  /** True when an existing PTY for the project was returned instead of spawning a fresh one. */
  reused: boolean;
}

export interface PtyExitInfo {
  code: number;
  signal: number;
}
