import type { MatcherRule } from './shared';

/**
 * OpenCode CLI patterns. OpenCode supports multiple upstream providers
 * (Anthropic, OpenAI, OpenRouter, Bedrock, Ollama, …), so its error
 * strings are heterogeneous. We catch the OpenCode-specific shapes here
 * and let the generic table absorb the rest.
 */
export const OPENCODE_RULES: readonly MatcherRule[] = [
  {
    pattern: /no provider configured/i,
    reason: 'auth_required',
    hint: 'Configure a provider in `opencode.json` or via Settings.',
  },
  {
    pattern: /api key (not (set|found)|missing|required)/i,
    reason: 'auth_required',
  },
  // ── OpenRouter aggregator policy block (hermes' provider_policy_blocked) ──
  {
    pattern: /no endpoints available matching your (guardrail|data policy)/i,
    reason: 'model_unavailable',
    hint: 'Adjust your OpenRouter privacy settings at https://openrouter.ai/settings/privacy.',
  },
  // ── Ollama local-server backed mode ──
  {
    pattern: /ollama.*not running|connection refused.*11434/i,
    reason: 'retry',
    hint: 'Start Ollama (`ollama serve`).',
  },
  // ── llama.cpp grammar (hermes' llama_cpp_grammar_pattern) ──
  {
    pattern: /json-schema-to-grammar/i,
    reason: 'retry',
  },
];
