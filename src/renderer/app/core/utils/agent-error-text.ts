import type { TranslateService } from '@ngx-translate/core';
import type { UserFacingError } from '../../../../shared/domain/user-facing-error';

/** `translate.instant` gives the key back when it has no entry: that means "no translation". */
function lookup(translate: Pick<TranslateService, 'instant'>, key: string, params: object | undefined): string | null {
  const text = translate.instant(key, params) as string;
  return typeof text === 'string' && text.length > 0 && text !== key ? text : null;
}

/**
 * The translated reading of an agent error (S-54). The code (and variant) pick
 * `agent_error.<code>.title|cause[_<variant>]`; a code the renderer has no key
 * for shows the main-side fallback text.
 */
export function agentErrorText(
  translate: Pick<TranslateService, 'instant'>,
  error: UserFacingError,
): { readonly title: string; readonly cause: string } {
  const base = `agent_error.${error.code}`;
  const params = error.params ?? {};
  const cause =
    (error.variant !== undefined ? lookup(translate, `${base}.cause_${error.variant}`, params) : null) ??
    lookup(translate, `${base}.cause`, params) ??
    error.cause;
  return { title: lookup(translate, `${base}.title`, params) ?? error.title, cause };
}
