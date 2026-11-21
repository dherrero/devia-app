import type { McpServerConfig } from '../../../../shared/domain/mcp';

export interface McpPartition {
  /** Servers the agent keeps seeing as ordinary MCP tools. */
  direct: McpServerConfig[];
  /** Servers reachable only from `run_script` through the code-mode gateway. */
  codeMode: McpServerConfig[];
}

/**
 * Splits the user's MCP servers by their `exposure` (S-50). Only `'codemode'`
 * leaves the direct set; `deferred`/`hidden` keep their existing meaning for the
 * agents that read them. `excludeIds` protects Devia's own servers: they depend
 * on the turn's context and must never end up behind a script.
 */
export function partitionMcpServers(
  servers: readonly McpServerConfig[],
  opts: { excludeIds?: readonly string[] } = {},
): McpPartition {
  const excluded = new Set(opts.excludeIds ?? []);
  const out: McpPartition = { direct: [], codeMode: [] };
  for (const s of servers) {
    if (s.exposure === 'codemode' && !excluded.has(s.id)) out.codeMode.push(s);
    else out.direct.push(s);
  }
  return out;
}
