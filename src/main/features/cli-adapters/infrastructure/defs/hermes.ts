import { ACP_PROFILES } from '../../../agents/acp/profile';
import type { RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { DEFAULT_MODEL_OPTION } from './shared';

const profile = ACP_PROFILES['hermes'];
if (!profile) throw new Error('hermes has no ACP profile');

/**
 * Hermes CLI adapter (ACP / JSON-RPC over stdio), run by the generic
 * `AcpMapper` (S-41). The argv (`hermes acp --accept-hooks`; `--accept-hooks`
 * auto-approves the agent's MCP tool hooks in headless runs) and the continuity
 * model come from its ACP profile. ACP has no system slot: the mapper prepends
 * the `[System]…[User]` header to the prompt block of every `session/prompt`.
 */
export const hermesAgentDef: RuntimeAgentDef = {
  id: 'hermes',
  name: 'Hermes',
  bin: 'hermes',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
  ],
  buildArgs: () => [...profile.args({ model: null })],
  streamFormat: 'acp-json-rpc',
  providerType: 'cli',
  applicability: 'direct',
  continuity: profile.continuity,
  systemPromptStrategy: 'stdin-prepend',
};
