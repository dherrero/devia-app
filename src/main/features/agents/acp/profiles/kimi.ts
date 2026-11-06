import type { AcpAgentProfile } from '../profile';
import { defaultToolName } from '../tool-name';

// unverified (T-447): continuity, planEnforcement, modeIds and the MCP tool-name pattern
// could not be checked against a real Kimi CLI, so the safe values are used.
export const kimiProfile: AcpAgentProfile = {
  id: 'kimi',
  args: () => ['acp'],
  continuity: 'replay',
  planEnforcement: 'none',
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  toolName: defaultToolName,
};
