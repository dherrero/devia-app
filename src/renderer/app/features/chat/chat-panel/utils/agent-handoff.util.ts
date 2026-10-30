import type { ChatMessage } from '../../../../../../shared/domain/chat';

/**
 * Pending cross-agent handoff detection (S-2 F3.3). Pure — shared by the
 * Settings toast and the premium handoff action (F3.4).
 */

export interface PendingHandoffCheck {
  /** The agent the user just switched to. */
  newAgentId: string;
  /** Focused session key (focusedSessionKey() ?? selectedProject()). */
  focusedKey: string | null;
  /** Other sessions mounted in split panes. */
  mountedKeys: readonly string[];
  /** Live transcripts keyed by session key. */
  chats: ReadonlyMap<string, readonly ChatMessage[]>;
}

export interface PendingHandoff {
  /** Owner of the focused session (or of the first affected one). */
  fromAgentId: string;
  /** Session keys whose last assistant turn belongs to ANOTHER agent. */
  affectedKeys: string[];
}

/** Last assistant `agentId` in a transcript, or null when it has none. */
export function lastAssistantAgentId(messages: readonly ChatMessage[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') continue;
    if (typeof msg.agentId === 'string' && msg.agentId.length > 0) return msg.agentId;
  }
  return null;
}

/**
 * S-2 F3.4: the toast's "ask the previous agent" action only makes sense when
 * that agent can actually run — detected, selectable and authenticated.
 */
export function canRequestHandoffSummary(
  agents: ReadonlyArray<{ id: string; selectable?: boolean; authStatus?: 'ok' | 'missing' | 'unknown' }> | null,
  fromAgentId: string,
): boolean {
  const agent = agents?.find((a) => a.id === fromAgentId);
  return !!agent && agent.selectable !== false && agent.authStatus === 'ok';
}

/**
 * S-2 F3.4: internal instruction for the PREVIOUS agent — produce a rich
 * handoff summary through `mem_session_summary` (the runner later prefers it
 * over the compressed/deterministic brief body). Spanish: it lands in the
 * agent's prompt for a Spanish-speaking product.
 */
export function buildHandoffRequestPrompt(): string {
  return [
    'Vas a traspasar esta sesión a otro agente. Llama a la herramienta mem_session_summary',
    'con un resumen de traspaso DETALLADO de esta conversación que incluya:',
    '- Objetivo de la sesión y estado actual del trabajo',
    '- Decisiones tomadas (con su porqué)',
    '- Siguiente paso concreto que debería ejecutar quien continúe',
    '- Ficheros tocados o relevantes',
    'No hagas ningún otro cambio. Responde con una sola línea confirmando que el resumen está guardado.',
  ].join('\n');
}

/**
 * Returns the sessions that will suffer a handoff if continued with
 * `newAgentId`, or null when none will. The focused session leads: its owner
 * is the `fromAgentId` shown in the toast when it is affected.
 */
export function detectPendingHandoff(check: PendingHandoffCheck): PendingHandoff | null {
  const keys: string[] = [];
  if (check.focusedKey !== null) keys.push(check.focusedKey);
  for (const key of check.mountedKeys) {
    if (!keys.includes(key)) keys.push(key);
  }

  const affected: Array<{ key: string; fromAgentId: string }> = [];
  for (const key of keys) {
    const owner = lastAssistantAgentId(check.chats.get(key));
    if (owner !== null && owner !== check.newAgentId) {
      affected.push({ key, fromAgentId: owner });
    }
  }
  if (affected.length === 0) return null;

  const focused = affected.find((a) => a.key === check.focusedKey);
  return {
    fromAgentId: (focused ?? affected[0]!).fromAgentId,
    affectedKeys: affected.map((a) => a.key),
  };
}
