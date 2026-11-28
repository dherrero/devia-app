import { explainProviderFailure } from './provider-failure';
import type { AgentExplainer } from './types';

/**
 * OpenCode's `APIError` frame reaches Devia as the provider's message text
 * (the status code stays in the wire frame), so this reads the text.
 */
export const opencodeExplainer: AgentExplainer = (input) => explainProviderFailure(input, 'OpenCode');
