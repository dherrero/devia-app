import { explainProviderFailure } from './provider-failure';
import type { AgentExplainer } from './types';

/** PI reports provider errors as text with the provider's JSON inside (`errorMessage`). */
export const piExplainer: AgentExplainer = (input) => explainProviderFailure(input, 'PI');
