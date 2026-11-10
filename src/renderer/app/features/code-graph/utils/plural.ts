/** The app's plural convention: `key` for exactly one, `key_plural` otherwise (zero included). */
export function pluralKey(key: string, count: number): string {
  return count === 1 ? key : `${key}_plural`;
}
