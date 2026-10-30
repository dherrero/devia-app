/**
 * DTOs for importing pre-existing CLI-agent sessions (S-20, generalises S-18).
 * Plain types, referenced across the IPC bridge — no Node/Electron/Angular
 * imports.
 */

/** One agent session that maps to a project inside the Devia workspace. */
export interface ImportableSession {
  /** CLI id of the producing agent (`claude`, `codex`, …). */
  agentId: string;
  /** The agent's native conversation id (reused as the Devia session id). */
  sessionId: string;
  /** True when continuing resumes the real native conversation (full context). */
  resumable: boolean;
  title?: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  /** True when a Devia session with this id already exists for the project. */
  alreadyImported: boolean;
}

/** Importable sessions grouped by the Devia project they belong to. */
export interface ImportableProject {
  /** Path relative to workspaceRoot — the Devia project id. */
  projectPath: string;
  /** Leaf name, for display. */
  projectName: string;
  sessions: ImportableSession[];
}

/** Importable projects grouped by the agent that produced the sessions. */
export interface ImportableAgent {
  agentId: string;
  projects: ImportableProject[];
}

/** A single session the user chose to import. */
export interface ImportSelection {
  agentId: string;
  projectPath: string;
  sessionId: string;
}

export interface ImportOptions {
  /** Re-import (overwrite) sessions that already exist. Default false. */
  force?: boolean;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  failed: number;
}
