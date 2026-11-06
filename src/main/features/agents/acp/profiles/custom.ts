import type { UserAcpConfig } from '../../../cli-adapters/domain/runtime-agent-def';
import type { AcpAgentProfile } from '../profile';
import { defaultToolName } from '../tool-name';

const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 256;
const MAX_MODE_ID_LENGTH = 64;
const MODE_KEYS = ['plan', 'apply', 'apply-yolo'] as const;
const CONTINUITY = ['native', 'replay'] as const;
const PLAN_ENFORCEMENT = ['agent-mode', 'permission-policy', 'none'] as const;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback;
}

/**
 * Validates the `acp` block of a user-supplied agent def (agent-defs.json) into a
 * canonical config, or null when its `args` are unusable. No `acp.args` means
 * `['acp']`, the most common launch convention. Unsafe or unknown values never
 * widen anything: continuity falls back to `replay` and plan enforcement to `none`.
 */
export function sanitiseUserAcp(raw: unknown): UserAcpConfig | null {
  const block = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawArgs = block['args'];
  let args: string[] = ['acp'];
  if (rawArgs !== undefined) {
    if (
      !Array.isArray(rawArgs) ||
      rawArgs.length > MAX_ARGS ||
      !rawArgs.every((a) => typeof a === 'string' && a.length <= MAX_ARG_LENGTH && !/[\r\n\0]/.test(a))
    ) {
      return null;
    }
    args = rawArgs as string[];
  }
  const rawModes = block['modeIds'];
  const modeIds: Partial<Record<(typeof MODE_KEYS)[number], string>> = {};
  if (rawModes !== null && typeof rawModes === 'object' && !Array.isArray(rawModes)) {
    for (const key of MODE_KEYS) {
      const value = (rawModes as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0 && value.length <= MAX_MODE_ID_LENGTH) modeIds[key] = value;
    }
  }
  return {
    args: [...args],
    continuity: pick(block['continuity'], CONTINUITY, 'replay'),
    planEnforcement: pick(block['planEnforcement'], PLAN_ENFORCEMENT, 'none'),
    modeIds,
  };
}

/** The ACP profile of a user-defined agent, or null when the def has no valid `acp` block. */
export function profileFromUserDef(def: { id: string; acp?: unknown }): AcpAgentProfile | null {
  if (def.acp === undefined || def.acp === null || typeof def.acp !== 'object') return null;
  const acp = sanitiseUserAcp(def.acp);
  if (!acp) return null;
  return {
    id: def.id,
    args: () => [...acp.args],
    continuity: acp.continuity,
    planEnforcement: acp.planEnforcement,
    ...(Object.keys(acp.modeIds).length > 0 && { modeIds: acp.modeIds }),
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    toolName: defaultToolName,
  };
}
