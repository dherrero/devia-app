/**
 * Gemini CLI auth-status probe (S-19 F2.1).
 *
 * Cheap, filesystem/env based — no CLI invocation (Gemini has no fast
 * auth-status subcommand). Considers the agent authenticated when an API key
 * is present in the effective env OR the OAuth credential file written by
 * `gemini` login exists. Never throws; never reads/logs the credential
 * contents. The runtime matchers (`gemini.matchers.ts`) stay the source of
 * truth on an actual failed run.
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

function homeDir(env: NodeJS.ProcessEnv): string {
  return firstNonEmpty(env.HOME, env.USERPROFILE);
}

export function probeGeminiAuthStatus(
  _resolvedBin: string,
  env: NodeJS.ProcessEnv,
): Promise<AuthProbeResult> {
  return Promise.resolve(detect(env));
}

function detect(env: NodeJS.ProcessEnv): AuthProbeResult {
  try {
    if (firstNonEmpty(env.GEMINI_API_KEY, env.GOOGLE_API_KEY)) {
      return { status: 'ok' };
    }
    const home = homeDir(env);
    if (!home) return { status: 'unknown' };
    // `gemini` stores OAuth credentials under ~/.gemini (cross-platform).
    if (existsSync(path.join(home, '.gemini', 'oauth_creds.json'))) {
      return { status: 'ok' };
    }
    return {
      status: 'missing',
      message: 'Gemini CLI no tiene credenciales. Define GEMINI_API_KEY o ejecuta `gemini` y completa el login.',
    };
  } catch {
    return { status: 'unknown' };
  }
}
