import { ACP_PROFILES } from '../../../agents/acp/profile';
import type { RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { DEFAULT_MODEL_OPTION } from './shared';

const profile = ACP_PROFILES['kimi'];
if (!profile) throw new Error('kimi has no ACP profile');

/**
 * Kimi CLI adapter (ACP / JSON-RPC over stdio), run by the generic `AcpMapper`
 * (S-41). The argv and the continuity model come from its ACP profile, the
 * single source of truth. ACP has no system slot: the mapper prepends the
 * `[System]…[User]` header to the prompt block of every `session/prompt`, so
 * the strategy is `stdin-prepend` in spirit.
 */
export const kimiAgentDef: RuntimeAgentDef = {
  id: 'kimi',
  name: 'Kimi CLI',
  bin: 'kimi',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'kimi-k2-turbo-preview', label: 'kimi-k2-turbo-preview' },
  ],
  buildArgs: () => [...profile.args({ model: null })],
  streamFormat: 'acp-json-rpc',
  installUrl: 'https://github.com/MoonshotAI/kimi-cli',
  providerType: 'cli',
  applicability: 'direct',
  continuity: profile.continuity,
  systemPromptStrategy: 'stdin-prepend',
};
