/**
 * Brief prompt guidance, only when THIS run was handed the gateway (decided from
 * the run's own delivery, never from a second lookup). It names the servers that
 * are no longer declared to the agent, because it has no other way to learn them.
 */
export function codeModeProtocol(args: { serverIds: readonly string[]; delivered: boolean }): string | null {
  if (!args.delivered || args.serverIds.length === 0) return null;
  return [
    `Code mode: the MCP servers ${args.serverIds.map((id) => `\`${id}\``).join(', ')} are not declared to you directly; they are reachable only through the \`devia-code-mode\` server.`,
    'Use `search_tools` to find their tools, then `run_script` with a short TypeScript script that calls them: filter and join the data inside the script and `return` only what you need.',
    'Scripts can only read; make any change with a normal tool call.',
  ].join(' ');
}
