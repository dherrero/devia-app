import type { AgentAnswer, AgentRunPlan, AgentSession, AgentSessionIo, AgentUiRequest } from '../domain';
import { answerText } from '../shared/stream-session';
import { DEVIA_MCP_SERVER_IDS, runPiRpcSession, type PiExtensionUiRequest } from './rpc-driver';

/**
 * pi's session (S-30 T-350): the RPC driver plus the translation of pi's
 * extension dialogs into Devia's canonical `AgentUiRequest` and of Devia's
 * `AgentAnswer` back into `extension_ui_response` (see `wire.ts`).
 *
 * `mcpServerIds` are the servers this run registered: pi sanitises their names
 * in tool names (`e2e-echo` → `e2e_echo`) and the driver maps them back to the
 * canonical `mcp__<serverId>__<tool>` the rest of Devia keys on.
 */
/** First non-empty of pi's dialog text fields; older drafts used question/prompt. */
function piDialogTitle(req: PiExtensionUiRequest, fallback: string): string {
  for (const key of ['title', 'question', 'message', 'prompt']) {
    const v = req.params?.[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return fallback;
}

function piOptions(req: PiExtensionUiRequest): AgentUiRequest['options'] {
  const raw = Array.isArray(req.params?.['options'])
    ? (req.params['options'] as unknown[])
    : Array.isArray(req.options) ? req.options : [];
  return raw.map((o, i) => {
    if (typeof o === 'string') return { id: String(i), label: o };
    const obj = o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
    return {
      id: String(obj['value'] ?? obj['id'] ?? i),
      label: String(obj['label'] ?? obj['value'] ?? obj['id'] ?? i),
      ...(typeof obj['description'] === 'string' && { description: obj['description'] }),
    };
  });
}

/** pi's wire for a dialog answer. */
function toPiResult(kind: AgentUiRequest['kind'], answer: AgentAnswer): Record<string, unknown> {
  if (answer.kind === 'cancel') return { cancelled: true };
  if (kind === 'confirm') return { confirmed: answer.kind === 'confirm' ? answer.confirmed : answerText(answer) === 'yes' };
  return { value: answerText(answer) };
}

export function openPiSession(
  io: AgentSessionIo,
  plan: AgentRunPlan,
  mcpServerIds: readonly string[] = DEVIA_MCP_SERVER_IDS,
): AgentSession {
  const pending = new Map<string, { rawId: string | number; kind: AgentUiRequest['kind'] }>();
  const pi = runPiRpcSession({
    child: io.process,
    prompt: plan.prompt,
    model: plan.model ?? null,
    imagePaths: plan.imagePaths,
    mcpServerIds,
    emit: io.emit,
    onExtensionUiRequest: (req) => {
      const callId = String(req.id);
      const options = piOptions(req) ?? [];
      const kind: AgentUiRequest['kind'] = req.method === 'confirm' ? 'confirm' : options.length > 0 ? 'select' : 'input';
      const fallback = kind === 'confirm' ? 'Confirm this action' : kind === 'select' ? 'Choose an option:' : 'Please respond:';
      // A confirm may name its action explicitly; then that alone is the action.
      const explicitAction = kind === 'confirm' && typeof req.params?.['action'] === 'string' ? req.params['action'] : undefined;
      const title = explicitAction ?? piDialogTitle(req, fallback);
      const message =
        explicitAction === undefined && typeof req.params?.['message'] === 'string' ? req.params['message'] : undefined;
      pending.set(callId, { rawId: req.id, kind });
      const surfaced = io.requestUi({
        callId,
        kind,
        purpose: 'question',
        title,
        ...(message !== undefined && message !== title && { message }),
        ...(options.length > 0 && { options }),
      });
      // false ⇒ pi's own auto-reply keeps a headless run from blocking.
      if (!surfaced) pending.delete(callId);
      return surfaced;
    },
  });
  return {
    flush: () => undefined,
    abort: () => pi.abort(),
    answer(callId: string, answer: AgentAnswer): boolean {
      const req = pending.get(callId);
      if (!req) return false;
      pending.delete(callId);
      pi.answerExtensionUi(req.rawId, toPiResult(req.kind, answer));
      return true;
    },
  };
}
