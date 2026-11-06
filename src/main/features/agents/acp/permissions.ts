import type { RunMode } from '../../../../shared/domain/run-capabilities';
import type { AcpAgentProfile, AcpToolCallLike } from './profile';

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

export type PermissionDecision =
  | { readonly kind: 'select'; readonly optionId: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'ask' };

const WRITE_KINDS: readonly string[] = ['edit', 'delete', 'move', 'execute'];
const READ_KINDS: readonly string[] = ['read', 'search', 'think', 'fetch'];

function firstOfKind(options: readonly AcpPermissionOption[], kinds: readonly string[]): AcpPermissionOption | null {
  for (const kind of kinds) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found;
  }
  return null;
}

export function rejectOption(options: readonly AcpPermissionOption[]): AcpPermissionOption | null {
  return firstOfKind(options, ['reject_once', 'reject_always']);
}

export function allowOption(options: readonly AcpPermissionOption[]): AcpPermissionOption | null {
  return firstOfKind(options, ['allow_always', 'allow_once']);
}

function selectAllow(options: readonly AcpPermissionOption[]): PermissionDecision {
  const allow = allowOption(options);
  return allow ? { kind: 'select', optionId: allow.optionId } : { kind: 'ask' };
}

export function decidePermission(input: {
  readonly toolCall: AcpToolCallLike;
  readonly options: readonly AcpPermissionOption[];
  readonly mode: RunMode;
  readonly isRemote: boolean;
  readonly serverIds: readonly string[];
  /** The Devia-owned servers of THIS run: an agent-chosen name alone never earns the plan-mode exemption. */
  readonly deviaServerIds: readonly string[];
  readonly profile: AcpAgentProfile;
}): PermissionDecision {
  const { toolCall, options, mode, isRemote, serverIds, deviaServerIds, profile } = input;
  const kind = toolCall.kind ?? '';
  const toolName = profile.toolName(toolCall, serverIds);
  const isDeviaTool = deviaServerIds.some((id) => toolName.startsWith(`mcp__${id}__`));

  if (mode === 'plan' && WRITE_KINDS.includes(kind) && !isDeviaTool) {
    const reject = rejectOption(options);
    return reject ? { kind: 'select', optionId: reject.optionId } : { kind: 'cancel' };
  }
  if (options.length === 0 || isRemote) return { kind: 'ask' };
  if (mode === 'apply-yolo') return selectAllow(options);
  if (mode === 'plan' && (READ_KINDS.includes(kind) || isDeviaTool)) return selectAllow(options);
  return { kind: 'ask' };
}
