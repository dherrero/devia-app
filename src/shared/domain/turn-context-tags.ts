/**
 * The tag that frames Devia's per-turn context block (S-40). Lives in
 * shared/domain because both sides of the block need it without importing each
 * other: the Claude mapper that writes it (main) and the session importer that
 * must not show it as the user's words (also reachable from shared code).
 */
export const TURN_CONTEXT_TAG = 'devia-turn-context';

/**
 * The user's text sits right after the block, so a literal copy of the tag in it
 * must not be able to open or close one. Escaping the `<` is enough.
 */
export function sanitizeTurnContextTags(text: string): string {
  return text.replace(new RegExp(`<(/?)${TURN_CONTEXT_TAG}`, 'gi'), `&lt;$1${TURN_CONTEXT_TAG}`);
}

/** A text block that IS the context block (it starts with the tag), not one that mentions it. */
export function isTurnContextBlock(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith(`<${TURN_CONTEXT_TAG}`);
}
