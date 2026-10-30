import type { TranscriptParser } from './domain/ports';
import type { ParsedTranscript } from '../../../shared/domain/agent-transcript';
import {
  parseClaudeTranscript,
  splitTranscriptLines,
} from '../../../shared/domain/claude-transcript';
import { parseCodexTranscript } from '../../../shared/domain/codex-transcript';
import { parseGrokTranscript } from '../../../shared/domain/grok-transcript';

/**
 * Adapts Claude's S-18 transcript parser to the generic `TranscriptParser`.
 * Claude is always natively resumable (`--resume <uuid>`).
 */
export const claudeParser: TranscriptParser = {
  agentId: 'claude',
  parse(text: string): ParsedTranscript | null {
    const parsed = parseClaudeTranscript(splitTranscriptLines(text));
    if (!parsed) return null;
    return {
      agentId: 'claude',
      agentSessionId: parsed.agentSessionId,
      messages: parsed.messages,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      cwd: parsed.cwd,
      resumable: true,
      ...(parsed.title !== undefined && { title: parsed.title }),
    };
  },
};

/** Codex rollout parser (native resume via `exec resume <uuid>`). */
export const codexParser: TranscriptParser = {
  agentId: 'codex',
  parse: parseCodexTranscript,
};

/** Grok session parser (native resume via `grok --session <id>`). */
export const grokParser: TranscriptParser = {
  agentId: 'grok',
  parse: parseGrokTranscript,
};
