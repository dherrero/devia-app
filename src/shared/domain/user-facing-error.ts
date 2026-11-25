/**
 * What the user sees when an agent fails (S-54): what happened, the likely
 * cause and what to do about it. Built in the main process from the raw agent
 * error; the raw text always travels beside it and stays available as
 * `details`.
 *
 * `code` + `params` are stable ids the renderer translates (es/en); `title`
 * and `cause` are the main-side fallback text for a code the renderer has no
 * key for. Importable from both processes: no Electron or Node imports here.
 */
export type ErrorAction =
  | { readonly kind: 'open_settings'; readonly section: string }
  | { readonly kind: 'pick_model' }
  | { readonly kind: 'login'; readonly agentId: string }
  | { readonly kind: 'enable_auto_continue'; readonly agentId: string }
  | { readonly kind: 'copy_details' }
  | { readonly kind: 'retry' };

export type ErrorActionKind = ErrorAction['kind'];

export interface UserFacingError {
  /** Stable id, also the i18n key suffix (`agent_error.<code>`). */
  readonly code: string;
  /** Values interpolated into the translated text (agent name, time, model…). */
  readonly params?: Readonly<Record<string, string | number>>;
  readonly title: string;
  readonly cause: string;
  readonly actions: readonly ErrorAction[];
  /** Technical detail for the collapsed section: the provider message, redacted. */
  readonly details: string;
}
