import type { MatcherRule } from './shared';

/**
 * Qoder CLI patterns. Qoder is a newer agent CLI with limited
 * documented error surface; we recognise the auth / quota strings the
 * binary produces today and let the generic provider rules absorb the
 * rest. As Qoder's CLI matures these rules will likely grow.
 */
export const QODER_RULES: readonly MatcherRule[] = [
  {
    pattern: /qoder.*(login|auth).*(required|expired)/i,
    reason: 'auth_required',
    hint: 'Run `qoder login`.',
  },
  {
    pattern: /qoder.*quota/i,
    reason: 'quota_exceeded',
  },
];
