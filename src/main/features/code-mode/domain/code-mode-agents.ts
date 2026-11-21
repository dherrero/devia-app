/**
 * Agents that can be handed the `devia-code-mode` gateway (S-50): the ones Devia's
 * other bundled servers already reach through the generic MCP delivery. `pi` is out
 * on purpose: it has its own native code mode (`exposure: 'codemode'` is its
 * default, and Devia writes the field into its config as it always did).
 *
 * One list, two users: the per-run planner decides who gets the gateway, and the MCP
 * sync decides whose native config files must NOT also declare a server that sits
 * behind it. They must agree, or an agent would see the same server both ways.
 */
const CODE_MODE_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini', 'opencode', 'cursor-agent', 'copilot', 'qwen']);

export function isCodeModeAgent(agentId: string): boolean {
  return CODE_MODE_AGENTS.has(agentId);
}
