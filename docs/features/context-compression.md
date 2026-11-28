# Context compression

Status: partial
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Summarise a long chat history with a cheap auxiliary LLM. In the current code its only live consumer is the cross-agent handoff summary ([session-handoff.md](session-handoff.md)); the general "compress history on overflow" path exists but no run calls it.

## Does

- `compress` / `compressIfOverflow` (`src/main/features/context-compression/application/context-compressor.ts`): keep `headKeep` head messages (default 1) and the last `tailKeep` turns (default 4), send the middle to an auxiliary LLM, stitch the summary back as one `assistant` message flagged `summary: true`, re-compress while over `targetBudget`; on `AuxiliaryLLMError` fall back to truncating the oldest middle messages (`fallback: 'truncate'`).
- `HandoffSummariser` (`.../application/handoff-summariser.ts`): precomputes, in the background, a summary used by the handoff brief (TTL `HANDOFF_SUMMARY_TTL_MS` = 10 min, one-shot). Wired in `src/main/shell/composition-root.ts` with `selectAuxiliaryClient(config.get().agentId)`.
- `selectAuxiliaryClient` (`.../infrastructure/auxiliary-llm-client.ts`): returns `AnthropicAuxiliaryLLMClient` (model `claude-haiku-4-5`, `https://api.anthropic.com/v1/messages`) only when the active agent is `claude` AND `ANTHROPIC_API_KEY` is set in the environment; otherwise `UnavailableAuxiliaryLLMClient` (never calls).
- Token estimation and budgets live in `src/shared/domain/context-budget.ts` (`estimateTokens`, `shouldCompress`, `getModelContextLength`, `replayBudgetChars`, `memoryHintBudgetChars`, `COMPRESS_RATIO` = 0.8, `MINIMUM_CONTEXT_LENGTH` = 64 000).

## Does NOT

- Does NOT compress the history of a normal run: `compress` and `compressIfOverflow` have no caller outside the feature and its tests (searched `src/main`, `src/shared`, `src/renderer`). The old README claim "resumes long history automatically with Haiku / GPT-5-mini / Gemini-Flash" is not what the code does.
- Has an auxiliary client ONLY for Claude with an API key in the environment. No OpenAI or Gemini client exists.
- Does NOT use the user's primary model for summarising.
- `plan-gate.ts` reads `DEVIA_PLAN` (`free` default, `pro`, `pro-cloud`, `enterprise`) and is a placeholder for a subscription gate; no code in this repo changes behaviour based on it beyond tests. Nothing outside the feature folder imports `plan-gate` (searched `src/main`, `src/shared`, `src/renderer`).

## Entry points

- `src/main/features/context-compression/index.ts` — public exports
- `src/main/features/context-compression/application/context-compressor.ts:compress` — algorithm
- `src/main/features/context-compression/application/handoff-summariser.ts:HandoffSummariser` — handoff precompute
- `src/main/features/context-compression/infrastructure/auxiliary-llm-client.ts:selectAuxiliaryClient` — client selection
- `src/main/features/context-compression/application/plan-gate.ts:currentPlan` — plan placeholder
- `src/shared/domain/context-budget.ts:estimateTokens` — budgets

## IPC / MCP surface

None.

## Persistence

None. The handoff summary cache is in memory.

## Config

- Env `ANTHROPIC_API_KEY` (read from `process.env` by `selectAuxiliaryClient`), env `DEVIA_PLAN`.

## Gotchas

- Audit-log entries for the truncate fallback are described in the compressor's doc comment; the runner does not currently invoke it.
- The algorithm was ported from `hermes-agent/agent/context_compressor.py` (see the source comment).

## Tests

- `src/main/features/context-compression/application/*.test.ts`. No test proves a real run compresses history, because none does.

## Related

- [session-handoff.md](session-handoff.md), [context-recovery.md](context-recovery.md), [session-stats.md](session-stats.md)
