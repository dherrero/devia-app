import type { ErrorAction, UserFacingError } from '../../../../../shared/domain/user-facing-error';
import { redactSecrets } from './nested-error';
import type { AgentExplainer, ExplainInput } from './types';

const LIMIT_TEXT = /hit your [a-z ]*limit|usage[ _]limit|claude usage limit/i;

/** `HH:MM` in the user's locale, with the day when it is not today. */
function formatReset(resetsAt: number, now: number = Date.now()): string {
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return sameDay ? time : `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

function usageLimit({ classified, ctx }: ExplainInput): UserFacingError {
  const time = ctx.resetsAt !== undefined ? formatReset(ctx.resetsAt) : undefined;
  const auto = ctx.autoContinueEnabled === true;
  let cause: string;
  if (time === undefined) {
    cause = 'Tu plan de Claude ha alcanzado su límite de uso. Podrás seguir cuando se reinicie la ventana.';
  } else if (auto) {
    cause = `Tu plan de Claude ha alcanzado su límite de uso. Devia continuará esta sesión solo a las ${time}.`;
  } else {
    cause = `Tu plan de Claude ha alcanzado su límite de uso. Se reinicia a las ${time}. Activa auto-continuar y Devia reanudará la sesión por ti.`;
  }
  const actions: ErrorAction[] = [];
  if (!auto && ctx.resetsAt !== undefined) actions.push({ kind: 'enable_auto_continue', agentId: ctx.agentId });
  actions.push({ kind: 'copy_details' });
  return {
    code: 'usage_limit',
    variant: time === undefined ? 'notime' : auto ? 'auto' : 'manual',
    params: {
      ...(ctx.resetsAt !== undefined && { resetsAt: ctx.resetsAt }),
      ...(time !== undefined && { time }),
      autoContinue: auto ? 1 : 0,
    },
    title: 'Límite de uso de Claude alcanzado',
    cause,
    actions,
    details: redactSecrets(classified.rawMessage),
  };
}

/**
 * Claude Code's own failures (S-54). The usage-limit reading only READS what the
 * run reported (`resetsAt`) and the auto-continue switch: scheduling the resume
 * is done elsewhere and is untouched by this file.
 */
export const claudeExplainer: AgentExplainer = (input) => {
  const { classified, ctx } = input;
  const raw = classified.rawMessage;
  const make = (code: string, title: string, cause: string, actions: readonly ErrorAction[]): UserFacingError => ({
    code,
    title,
    cause,
    actions: [...actions, { kind: 'copy_details' }],
    details: redactSecrets(raw),
  });

  if (LIMIT_TEXT.test(raw) || ctx.resetsAt !== undefined) return usageLimit(input);

  if (/enterprise mcp config is present|(--strict-mcp-config|dynamically configure mcp servers).*enterprise/i.test(raw)) {
    return make(
      'enterprise_mcp',
      'Tu organización gestiona la configuración MCP de Claude',
      'No se pueden añadir servidores MCP por ejecución. Define DEVIA_ASSUME_ENTERPRISE_MCP=1 para que Devia los omita, o pide a IT que añada los servidores de Devia.',
      [],
    );
  }
  if (/not logged in|run\s+`?claude\s+login`?|\/login/i.test(raw)) {
    return make('auth_required', 'Claude no tiene la sesión iniciada', 'Inicia sesión en Claude Code o configura ANTHROPIC_API_KEY en Ajustes.', [
      { kind: 'login', agentId: ctx.agentId },
      { kind: 'open_settings', section: 'execution' },
    ]);
  }
  if (/image exceeds 5\s?MB/i.test(raw)) {
    return make('image_too_large', 'Una imagen es demasiado grande', 'Anthropic limita cada imagen a 5 MB. Reduce la imagen adjunta y vuelve a enviarla.', [{ kind: 'retry' }]);
  }
  if (/prompt is too long|agent_prompt_too_large/i.test(raw) || classified.reason === 'compress_context') {
    return make('context_too_large', 'La conversación es demasiado larga', 'El mensaje, los adjuntos o el historial superan el contexto del modelo. Empieza una sesión nueva o acorta el mensaje.', []);
  }
  if (/oauth.*long.?context.*beta/i.test(raw) || /long.?context.*tier|extra usage tier/i.test(raw)) {
    return make('model_unavailable', 'Tu plan no incluye el contexto largo', 'Tu suscripción no incluye el modelo de contexto de 1M. Elige otro modelo en Ajustes › Ejecución.', [
      { kind: 'pick_model' },
      { kind: 'open_settings', section: 'execution' },
    ]);
  }
  if (/anthropic[^\n]{0,40}(529|overloaded_error)|overloaded_error/i.test(raw)) {
    return make('transient', 'Anthropic está saturado', 'Los servidores de Anthropic están sobrecargados ahora mismo. Suele resolverse en un momento.', [{ kind: 'retry' }]);
  }
  return null;
};
