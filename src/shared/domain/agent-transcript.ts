import type { ChatMessage } from './chat';

/**
 * Generic, agent-agnostic transcript contracts shared by every importer
 * (S-20). The Claude-specific S-18 pipeline is one concrete implementation of
 * these; Codex/Gemini/OpenCode/… plug in by providing a reader + a parser that
 * yields a `ParsedTranscript`.
 *
 * Pure domain code: NO Node/Electron imports.
 */

/** A discovered transcript on disk, addressable by a native conversation id. */
export interface SessionTranscriptRef {
  /** The agent's native conversation id (filename uuid, rollout uuid, …). */
  nativeId: string;
  /**
   * Path the reader's `read()` understands. For single-file agents this is the
   * transcript file; for multi-file storage (e.g. OpenCode) it is whatever the
   * reader needs to assemble the aggregate — the parser never touches disk.
   */
  filePath: string;
}

/**
 * The normalised result of parsing one transcript, enough to persist it as a
 * Devia session and to drive the import UI.
 */
export interface ParsedTranscript {
  /** CLI id of the agent that produced the transcript (`claude`, `codex`, …). */
  agentId: string;
  /** Native conversation id — reused as the Devia session id + `agentSessionId`. */
  agentSessionId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** Absolute cwd the session ran in, read FROM the transcript (never a lossy
   *  directory name). */
  cwd: string;
  title?: string;
  /**
   * True when continuing the imported session resumes the agent's real native
   * conversation (`--resume` / `exec resume`), recovering full prior context.
   * False for agents Devia continues by re-seeding the transcript (replay).
   */
  resumable: boolean;
}
