import type { FailoverReason } from '../../../../../shared/domain/cli-errors';
import type { ErrorAction, UserFacingError } from '../../../../../shared/domain/user-facing-error';
import { redactSecrets } from './nested-error';
import type { ExplainInput } from './types';

interface Shape {
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly actions: (agentId: string) => readonly ErrorAction[];
}

const SETTINGS: ErrorAction = { kind: 'open_settings', section: 'execution' };

const BY_REASON: Readonly<Record<FailoverReason, Shape>> = {
  auth_required: {
    code: 'auth_required',
    title: 'El agente no está autenticado',
    cause: 'La sesión o la clave del agente falta o no es válida.',
    actions: (agentId) => [{ kind: 'login', agentId }, SETTINGS],
  },
  rotate_credential: {
    code: 'auth_required',
    title: 'El agente no está autenticado',
    cause: 'La credencial del agente ha caducado o fue revocada.',
    actions: (agentId) => [{ kind: 'login', agentId }, SETTINGS],
  },
  quota_exceeded: {
    code: 'quota_exceeded',
    title: 'Cuota o saldo agotado',
    cause: 'El plan o el saldo del proveedor no permite más peticiones ahora mismo.',
    actions: () => [SETTINGS],
  },
  rate_limited: {
    code: 'rate_limited',
    title: 'Demasiadas peticiones',
    cause: 'El proveedor está limitando las peticiones. Suele resolverse esperando un momento.',
    actions: () => [{ kind: 'retry' }],
  },
  model_unavailable: {
    code: 'model_unavailable',
    title: 'Modelo no disponible',
    cause: 'El modelo que usa el agente no existe o no está disponible para tu cuenta.',
    actions: () => [{ kind: 'pick_model' }, SETTINGS],
  },
  compress_context: {
    code: 'context_too_large',
    title: 'La conversación es demasiado larga',
    cause: 'El mensaje, los adjuntos o el historial superan lo que admite el modelo.',
    actions: () => [],
  },
  retry: {
    code: 'transient',
    title: 'Fallo temporal',
    cause: 'El proveedor o la red han fallado de forma transitoria.',
    actions: () => [{ kind: 'retry' }],
  },
  fallback_provider: {
    code: 'unknown',
    title: 'El agente ha fallado',
    cause: 'Prueba con otro agente o revisa los detalles técnicos.',
    actions: () => [SETTINGS],
  },
  unrecoverable: {
    code: 'unknown',
    title: 'El agente ha fallado',
    cause: 'Devia no reconoce este error. Los detalles técnicos muestran lo que devolvió el agente.',
    actions: () => [],
  },
};

const COPY: ErrorAction = { kind: 'copy_details' };

/** The reason-based mapping every agent falls back to. */
export function genericExplain({ classified, ctx }: ExplainInput): UserFacingError {
  const shape = BY_REASON[classified.reason] ?? BY_REASON.unrecoverable;
  const cause = classified.hint ? `${shape.cause} ${classified.hint}` : shape.cause;
  const actions = ctx.origin === 'remote' ? [] : [...shape.actions(ctx.agentId), COPY];
  return {
    code: shape.code,
    title: shape.title,
    cause,
    actions,
    details: redactSecrets(classified.rawMessage),
  };
}
