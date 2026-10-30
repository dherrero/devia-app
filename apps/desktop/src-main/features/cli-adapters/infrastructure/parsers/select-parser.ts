import type { RuntimeAgentDef } from '../../domain/runtime-agent-def';
import type { AgentEventSink, StreamParser } from '../../domain/stream-parser';
// Claude's decoder lives with its mapper (S-30); kept here for user-defined
// agents that declare the claude-stream-json format.
import { createClaudeStreamParser } from '../../../agents/claude/decoder';
import { createCodexEventStreamParser } from './codex-event-stream';
import { createGeminiEventStreamParser } from './gemini-event-stream';
import { createOpencodeEventStreamParser } from '../../../agents/opencode/decoder';
import { createCursorAgentEventStreamParser } from './cursor-agent-event-stream';
import { createCopilotEventStreamParser } from './copilot-event-stream';
import { createQoderEventStreamParser } from './qoder-event-stream';
import { createGrokEventStreamParser } from './grok-event-stream';
import { createPlainTextParser } from './plain-text';

/**
 * Look up the parser implementation a given agent definition needs. The
 * launcher calls this once per spawn and pipes the child's stdout
 * through the returned parser, which emits Claude-stream-json lines the
 * renderer already understands.
 */
export function selectStreamParser(
  def: RuntimeAgentDef,
  sink: AgentEventSink,
): StreamParser {
  if (def.streamFormat === 'claude-stream-json') {
    return createClaudeStreamParser(sink);
  }
  if (def.streamFormat === 'json-event-stream') {
    switch (def.eventParser) {
      case 'codex':        return createCodexEventStreamParser(sink);
      case 'gemini':       return createGeminiEventStreamParser(sink);
      case 'opencode':     return createOpencodeEventStreamParser(sink);
      case 'cursor-agent': return createCursorAgentEventStreamParser(sink);
      case 'copilot':      return createCopilotEventStreamParser(sink);
      case 'qoder':        return createQoderEventStreamParser(sink);
      case 'grok':         return createGrokEventStreamParser(sink);
      default:             return createPlainTextParser(sink);
    }
  }
  return createPlainTextParser(sink);
}
