import type { AcpAgentProfile } from '../profile';
import { defaultToolName } from '../tool-name';

// unverified (T-447): continuity, planEnforcement, modeIds and the MCP tool-name pattern
// could not be checked against a real Hermes CLI, so the safe values are used.
export const hermesProfile: AcpAgentProfile = {
  id: 'hermes',
  args: () => ['acp', '--accept-hooks'],
  continuity: 'replay',
  planEnforcement: 'none',
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  toolName: defaultToolName,
};
