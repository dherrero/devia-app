import type { RuntimeAgentDef } from '../../../cli-adapters/domain/runtime-agent-def';
import { choosePermissionOutcome, runAcpSession } from '../../../cli-adapters/infrastructure/acp/acp-session';
import { selectStreamParser } from '../../../cli-adapters/infrastructure/parsers/select-parser';
import { openPiSession } from '../../pi/session';
import type {
  AgentAnswer,
  AgentRunPlan,
  AgentSession,
  AgentSessionIo,
} from '../../domain';
import { answerText, openStreamSession } from '../../shared/stream-session';

/**
 * Opens the session for a `RuntimeAgentDef` — the stream decoding and stdin
 * protocol the launcher used to pick by `streamFormat` (S-30 T-347).
 *
 * Every native dialog the agent raises (ACP permission, pi extension UI) is
 * turned into ONE canonical `AgentUiRequest`, and every answer arrives as ONE
 * canonical `AgentAnswer`; translating both to the agent's wire is this
 * module's job, not the core's.
 */
export function openLegacySession(def: RuntimeAgentDef, io: AgentSessionIo, plan: AgentRunPlan): AgentSession {
  if (def.streamFormat === 'acp-json-rpc') return openAcpSession(io, plan);
  if (def.streamFormat === 'pi-rpc') return openPiSession(io, plan);
  return openStreamSession(def, io, (emit) => selectStreamParser(def, emit));
}

// ── ACP (kimi, hermes) ─────────────────────────────────────────────────────

function openAcpSession(io: AgentSessionIo, plan: AgentRunPlan): AgentSession {
  const pending = new Set<string>();
  const acp = runAcpSession({
    child: io.process,
    prompt: plan.prompt,
    cwd: plan.cwd,
    model: plan.model ?? null,
    imagePaths: [...plan.imagePaths],
    emit: io.emit,
    onPermissionRequest: (req) => {
      pending.add(req.id);
      const surfaced = io.requestUi({
        callId: req.id,
        kind: 'select',
        purpose: 'permission',
        title: req.title,
        options: req.options.map((o) => ({ id: o.optionId, label: o.label })),
      });
      if (!surfaced) {
        // Nobody can draw the card: the driver's own headless choice.
        pending.delete(req.id);
        acp.answerPermission(req.id, choosePermissionOutcome(req.options) ?? '');
      }
    },
  });
  return {
    flush: () => undefined,
    abort: () => acp.abort(),
    answer(callId: string, answer: AgentAnswer): boolean {
      if (!pending.delete(callId)) return false;
      // The chosen option label (or optionId) — what the driver matches on.
      acp.answerPermission(callId, answerText(answer));
      return true;
    },
  };
}
