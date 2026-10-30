import { StringDecoder } from 'node:string_decoder';
import type { AgentEvent } from '../../../../shared/domain/agent-event';
import type { RuntimeAgentDef } from '../../cli-adapters/domain/runtime-agent-def';
import type { AgentEventSink, StreamParser } from '../../cli-adapters/domain/stream-parser';
import type { AgentAnswer, AgentSession, AgentSessionIo } from '../domain';

/**
 * A session over a CLI that streams its events on stdout (every agent but the
 * stdio RPC ones). The parser is the agent's decoder; this module owns the
 * plumbing shared by all of them — and Claude's stream-json stdin, where an
 * answer to an agent's own picker is a `tool_result` written mid-turn.
 */
export function openStreamSession(
  def: RuntimeAgentDef,
  io: AgentSessionIo,
  createParser: (emit: AgentEventSink) => StreamParser,
): AgentSession {
  // Claude keeps stdin open (stream-json) so a tool_result can be injected
  // mid-turn; it closes once a turn ends for any reason other than tool_use.
  const keepsStdinOpen = def.promptViaStdin === true && def.promptInputFormat === 'stream-json';
  let stdinOpen = keepsStdinOpen && io.stdin !== null;
  const closeStdin = (): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    try { io.stdin?.end(); } catch { /* the process may already be gone */ }
  };
  const emit = (event: AgentEvent): void => {
    io.emit(event);
    if (keepsStdinOpen && event.type === 'turn_end' && event.stopReason !== 'tool_use') closeStdin();
  };
  const parser = createParser(emit);
  // A multi-byte UTF-8 character can straddle two chunks; decoding each chunk
  // on its own would corrupt it (ñ, accents, emoji in the model's text).
  const decoder = new StringDecoder('utf8');
  io.stdout.on('data', (chunk: Buffer) => parser.feed(decoder.write(chunk)));
  io.process.once('close', () => { stdinOpen = false; });
  return {
    flush: () => {
      const tail = decoder.end();
      if (tail) parser.feed(tail);
      parser.flush();
    },
    abort: () => undefined,
    answer(callId: string, answer: AgentAnswer): boolean {
      if (!keepsStdinOpen) return false;
      if (!stdinOpen) {
        console.debug(`[agents:${def.id}] answer: stdin already closed (callId=${callId}) — skipping`);
        return true;
      }
      try {
        io.stdin?.write(buildToolResultPayload(callId, answerText(answer)));
      } catch (err) {
        console.warn(`[agents:${def.id}] answer write error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    },
  };
}

function sanitiseToolResultText(content: string): string {
  return content.slice(0, 10_000).replace(/\0/g, '');
}

/** A tool_result answering a tool_use on Claude's stream-json stdin. */
export function buildToolResultPayload(toolUseId: string, content: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: sanitiseToolResultText(content) }],
      },
      parent_tool_use_id: toolUseId,
      isSynthetic: true,
    }) + '\n'
  );
}

export function answerText(answer: AgentAnswer): string {
  switch (answer.kind) {
    case 'text': return answer.text;
    case 'select': return answer.value;
    case 'confirm': return answer.confirmed ? 'yes' : 'no';
    case 'cancel': return 'cancelled';
  }
}
