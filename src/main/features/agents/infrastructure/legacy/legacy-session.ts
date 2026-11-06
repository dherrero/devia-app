import type { RuntimeAgentDef } from '../../../cli-adapters/domain/runtime-agent-def';
import { selectStreamParser } from '../../../cli-adapters/infrastructure/parsers/select-parser';
import { openPiSession } from '../../pi/session';
import type { AgentRunPlan, AgentSession, AgentSessionIo } from '../../domain';
import { openStreamSession } from '../../shared/stream-session';

/**
 * Opens the session for a `RuntimeAgentDef` — the stream decoding and stdin
 * protocol the launcher used to pick by `streamFormat` (S-30 T-347).
 *
 * Every native dialog the agent raises (pi extension UI) is
 * turned into ONE canonical `AgentUiRequest`, and every answer arrives as ONE
 * canonical `AgentAnswer`; translating both to the agent's wire is this
 * module's job, not the core's.
 */
export function openLegacySession(def: RuntimeAgentDef, io: AgentSessionIo, plan: AgentRunPlan): AgentSession {
  if (def.streamFormat === 'pi-rpc') return openPiSession(io, plan);
  return openStreamSession(def, io, (emit) => selectStreamParser(def, emit));
}
