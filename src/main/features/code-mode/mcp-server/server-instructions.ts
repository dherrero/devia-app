import type { McpServerConfig } from '../../../../shared/domain/mcp';

/**
 * What the agent is told when it connects to `devia-code-mode`. It names the
 * servers that live behind the gateway (the agent has no other way to know them,
 * since their tools are no longer declared to it directly).
 */
export function buildServerInstructions(servers: readonly McpServerConfig[]): string {
  const list =
    servers.length > 0
      ? servers.map((s) => `- ${s.id}${s.description ? `: ${s.description}` : ''}`).join('\n')
      : '- (none)';
  return [
    'devia-code-mode does multi-step work across several MCP servers in ONE call: you write a short TypeScript script, Devia runs it in a sandbox, and only the value you `return` comes back to you.',
    '',
    'These MCP servers are reachable ONLY through scripts (their tools are not declared to you directly):',
    list,
    '',
    'How to use it:',
    '1. `search_tools` finds tools by keyword (no query: lists the servers). `get_types` returns the TypeScript declarations for the servers you will use.',
    '2. `run_script` takes the body of an async function: `await` and `return` work at the top level. The only globals are `tools` (`await tools.<server>.<tool>({...})`) and `console.log`. There is no network, filesystem, process or timers.',
    '3. Do the filtering, joining and aggregating INSIDE the script and return only what you need: the data between calls never reaches your context. Use `Promise.all` for independent calls.',
    '',
    'Rules:',
    '- Scripts can only READ. A tool that is not marked read-only is denied (the call throws a `ToolDeniedError`); return what you found and make the change with a normal tool call instead.',
    '- A tool whose output shape is not declared returns `any`. Run a first small script that returns a sample (for example the first 2 items) to see its shape before writing the real one.',
    '- The script is type-checked before it runs; a type error costs nothing (no tool is called). Fix it and send it again.',
    '- Limits per script: wall-clock time, memory, number of tool calls and size of the returned value. Exceeding one fails the run with a message saying which.',
  ].join('\n');
}
