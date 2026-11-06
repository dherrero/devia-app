import type { RunMode } from '../../../../shared/domain/run-capabilities';
import { hermesProfile } from './profiles/hermes';
import { kimiProfile } from './profiles/kimi';
import type { AcpToolCallLike } from './tool-name';

export { defaultToolName } from './tool-name';
export type { AcpToolCallLike } from './tool-name';

export type AcpPlanEnforcement = 'agent-mode' | 'permission-policy' | 'none';

export interface AcpClientCapabilities {
  readonly fs: { readonly readTextFile: boolean; readonly writeTextFile: boolean };
  readonly terminal: boolean;
}

export interface AcpAgentProfile {
  readonly id: string;
  readonly args: (ctx: { readonly model: string | null }) => readonly string[];
  readonly continuity: 'native' | 'replay';
  readonly planEnforcement: AcpPlanEnforcement;
  readonly modeIds?: Partial<Record<RunMode, string>>;
  readonly clientCapabilities: AcpClientCapabilities;
  /** MCP tools MUST come out as `mcp__<serverId>__<tool>` (contract A); built-ins keep the agent's vocabulary. */
  readonly toolName: (call: AcpToolCallLike, serverIds: readonly string[]) => string;
  readonly authMethodId?: string;
}

export const ACP_PROFILES: Readonly<Record<string, AcpAgentProfile>> = {
  kimi: kimiProfile,
  hermes: hermesProfile,
};

export function profileFor(agentId: string): AcpAgentProfile | undefined {
  return Object.hasOwn(ACP_PROFILES, agentId) ? ACP_PROFILES[agentId] : undefined;
}
