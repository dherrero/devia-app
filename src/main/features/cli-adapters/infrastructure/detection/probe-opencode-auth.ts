/**
 * OpenCode auth-status probe (S-19 F2.1).
 *
 * Cheap, filesystem/env based — no CLI invocation. Considers OpenCode
 * authenticated when a known provider API key is present in the effective env
 * OR the `auth.json` written by `opencode auth login` exists under the XDG
 * data dir. Never throws; never reads/logs the credential contents. On Windows
 * (where OpenCode's data path is not the XDG layout) an absent key returns
 * `unknown` rather than a misleading `missing`. The runtime matchers
 * (`opencode.matchers.ts`) stay the source of truth on an actual failed run.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { AuthProbeResult } from '../../domain/runtime-agent-def';

function firstNonEmpty(...vals: (string | undefined)[]): string {
  for (const v of vals) {
    const t = (v ?? '').trim();
    if (t) return t;
  }
  return '';
}

export function probeOpencodeAuthStatus(
  _resolvedBin: string,
  env: NodeJS.ProcessEnv,
): Promise<AuthProbeResult> {
  return Promise.resolve(detect(env));
}

function detect(env: NodeJS.ProcessEnv): AuthProbeResult {
  try {
    if (firstNonEmpty(
      env.ANTHROPIC_API_KEY,
      env.OPENAI_API_KEY,
      env.GOOGLE_API_KEY,
      env.OPENROUTER_API_KEY,
    )) {
      return { status: 'ok' };
    }
    const home = firstNonEmpty(env.HOME, env.USERPROFILE);
    const dataHome = firstNonEmpty(env.XDG_DATA_HOME)
      || (home ? path.join(home, '.local', 'share') : '');
    if (dataHome && existsSync(path.join(dataHome, 'opencode', 'auth.json'))) {
      return { status: 'ok' };
    }
    // Without the XDG layout (Windows) we cannot locate the auth file, so we
    // can't confidently say it is missing.
    if (process.platform === 'win32' || !dataHome) {
      return { status: 'unknown' };
    }
    return {
      status: 'missing',
      message: 'OpenCode no tiene proveedor configurado. Ejecuta `opencode auth login` o define una API key (p. ej. ANTHROPIC_API_KEY).',
    };
  } catch {
    return { status: 'unknown' };
  }
}
