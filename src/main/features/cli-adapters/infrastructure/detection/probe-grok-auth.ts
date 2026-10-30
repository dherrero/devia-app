/**
 * Grok CLI auth-status probe (S-21).
 *
 * Cheap, filesystem/env based — no CLI invocation. Considers grok-dev
 * authenticated when `GROK_API_KEY` is set OR `~/.grok/user-settings.json`
 * carries a non-empty `apiKey`. Never throws; never returns/logs the credential
 * value. The runtime matchers (`grok.matchers.ts`) stay the source of truth on
 * an actual failed run.
 */
import { existsSync, readFileSync } from 'node:fs';
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

export function probeGrokAuthStatus(
  _resolvedBin: string,
  env: NodeJS.ProcessEnv,
): Promise<AuthProbeResult> {
  return Promise.resolve(detect(env));
}

function detect(env: NodeJS.ProcessEnv): AuthProbeResult {
  try {
    if (firstNonEmpty(env.GROK_API_KEY)) return { status: 'ok' };
    const home = homeDir(env);
    if (!home) return { status: 'unknown' };
    const settingsPath = path.join(home, '.grok', 'user-settings.json');
    if (existsSync(settingsPath)) {
      try {
        const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as { apiKey?: unknown };
        if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) return { status: 'ok' };
      } catch {
        /* malformed settings — treat as not configured */
      }
    }
    return {
      status: 'missing',
      message: 'Grok no tiene credenciales. Define GROK_API_KEY o guarda apiKey en ~/.grok/user-settings.json.',
    };
  } catch {
    return { status: 'unknown' };
  }
}
