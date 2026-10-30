import type { ChatError } from '../../../../shared/domain/chat-error';

/**
 * User-visible copy produced from a `ChatError.code`.
 *
 * Callers must use this function to translate error codes into display text —
 * UI components must never inspect `code` values directly so that copy can
 * change without touching component code.
 */
export interface ErrorUiCopy {
  /** Primary error message for the inline banner. */
  message: string;
  /** Optional CTA label for the "Fix" link (e.g. "Open Settings"). */
  action?: string;
}

/**
 * Trusted URL allowlist for `recoveryHint` links.
 * Only hostnames on this list are passed through; anything else is replaced
 * with a generic "Open Settings" link to prevent phishing redirection (AC6).
 */
const TRUSTED_HINT_PATTERNS: RegExp[] = [
  /^https?:\/\/(www\.)?anthropic\.com(\/|$)/,
  /^https?:\/\/(www\.)?openai\.com(\/|$)/,
  /^https?:\/\/(www\.)?google\.com(\/|$)/,
  /^devia:\/\//,  // In-app deep links
];

export function isTrustedRecoveryHint(url: string): boolean {
  return TRUSTED_HINT_PATTERNS.some((re) => re.test(url));
}

const CODE_COPY: Record<string, ErrorUiCopy> = {
  BAD_REQUEST: { message: 'La solicitud no es válida. Revisa los parámetros e inténtalo de nuevo.' },
  PROVIDER_UNKNOWN: { message: 'El agente seleccionado no existe. Cambia el agente en Ajustes.', action: 'Abrir Ajustes' },
  PROVIDER_UNAVAILABLE: { message: 'El agente no está disponible. Comprueba que está instalado.', action: 'Instalar agente' },
  AUTH_REQUIRED: { message: 'Es necesario iniciar sesión en el agente.', action: 'Ir a Ajustes' },
  PROMPT_TOO_LARGE: { message: 'El mensaje es demasiado largo. Reduce su tamaño e inténtalo de nuevo.' },
  SPAWN_FAILED: { message: 'No se pudo iniciar el agente. Comprueba la instalación.' },
  INACTIVITY_TIMEOUT: { message: 'El agente no respondió dentro del tiempo límite. Inténtalo de nuevo.' },
  PARSER_DESYNC: { message: 'El stream del agente produjo datos inesperados. Revisa la versión del agente.' },
  EMPTY_OUTPUT: { message: 'El agente terminó sin producir ninguna respuesta.' },
  STORE_CONFLICT: { message: 'Ocurrió un error interno al guardar la sesión.', action: 'Copiar diagnóstico' },
  RATE_LIMITED: { message: 'Límite de solicitudes alcanzado. Espera un momento e inténtalo de nuevo.' },
  UPSTREAM_UNAVAILABLE: { message: 'No se pudo contactar con el servicio. Verifica la conexión.' },
  CANCELED: { message: 'La solicitud fue cancelada.' },
  INTERNAL: { message: 'Ocurrió un error interno.', action: 'Copiar diagnóstico' },
};

/**
 * Map a `ChatError` to user-facing display copy.
 *
 * The returned `action` is a generic label; the UI must resolve the actual
 * href from `error.recoveryHint` (validated through `isTrustedRecoveryHint`).
 */
export function mapErrorToUi(error: ChatError): ErrorUiCopy {
  const entry = CODE_COPY[error.code];
  if (entry) return entry;
  // Unknown code — generic copy
  return { message: 'Ocurrió un error inesperado.', action: 'Copiar diagnóstico' };
}

/**
 * Returns a validated `recoveryHint` URL, or `undefined` if it is not trusted.
 * Use this before rendering a "Fix" link to prevent phishing redirection (AC6).
 */
export function validateRecoveryHint(hint: string | undefined): string | undefined {
  if (hint === undefined) return undefined;
  return isTrustedRecoveryHint(hint) ? hint : undefined;
}
