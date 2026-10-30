import type { RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { DEFAULT_MODEL_OPTION } from './shared';

/**
 * Hermes CLI adapter (ACP / JSON-RPC over stdio).
 *
 * Spawned as `hermes acp --accept-hooks` (`--accept-hooks` auto-approves the
 * agent's MCP tool hooks in headless runs); the launcher hands the child to the
 * ACP session driver. Devia's system prompt is not injected into ACP sessions
 * yet (`systemPromptStrategy: 'unsupported'`).
 */
export const hermesAgentDef: RuntimeAgentDef = {
  id: 'hermes',
  name: 'Hermes',
  bin: 'hermes',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
  ],
  buildArgs: () => ['acp', '--accept-hooks'],
  streamFormat: 'acp-json-rpc',
  providerType: 'cli',
  applicability: 'direct',
  systemPromptStrategy: 'unsupported',
};
