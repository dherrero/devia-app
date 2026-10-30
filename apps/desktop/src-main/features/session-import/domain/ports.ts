import type { ParsedTranscript, SessionTranscriptRef } from '../../../../shared/domain/agent-transcript';

/**
 * Read-only access to one agent's transcripts on disk. Abstracted so the
 * scan/import use-cases can be unit-tested with an in-memory fake, and so each
 * agent (Claude, Codex, …) plugs in by providing a reader + a parser.
 */
export interface SessionTranscriptReader {
  /** CLI id of the agent these transcripts belong to. */
  readonly agentId: string;
  /** Whether the agent's transcript storage exists at all. */
  available(): boolean;
  /** Lists every top-level transcript (excludes subagent sidechains). */
  listTranscripts(): SessionTranscriptRef[];
  /** Reads the raw text the parser consumes; null on any IO error. */
  read(filePath: string): string | null;
}

/** Pure transcript parser for one agent. */
export interface TranscriptParser {
  readonly agentId: string;
  parse(text: string): ParsedTranscript | null;
}

/** A (reader, parser) pair: everything needed to import one agent's sessions. */
export interface ImportSource {
  reader: SessionTranscriptReader;
  parser: TranscriptParser;
}
