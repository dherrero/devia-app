import type { RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { DEFAULT_MODEL_OPTION } from './shared';

/**
 * Kimi CLI adapter (ACP / JSON-RPC over stdio).
 *
 * Spawned as `kimi acp`; the launcher hands the child to the ACP session driver
 * which drives `initialize → session/new → session/prompt`. The Devia system
 * prompt is not injected into ACP sessions yet (`systemPromptStrategy:
 * 'unsupported'`), and per-action permission requests are auto-approved by the
 * driver.
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
  buildArgs: () => ['acp'],
  streamFormat: 'acp-json-rpc',
  installUrl: 'https://github.com/MoonshotAI/kimi-cli',
  providerType: 'cli',
  applicability: 'direct',
  systemPromptStrategy: 'unsupported',
};
