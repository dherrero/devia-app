/**
 * Sent once in the MCP `initialize` response; the single source of tool guidance
 * (the agent prompt block only names the tools). Keep it under 120 words.
 */
export const SERVER_INSTRUCTIONS =
  'devia-code-graph is a pre-built graph of every symbol, call and import in this project. ' +
  'Use it instead of grep/find for structure, flow and impact questions. ' +
  'Start with graph_explore and a bag of exact symbol names (also Class.method or file.ts#name): ' +
  'one call returns their source and the call path between them. ' +
  'Use graph_node for one symbol, graph_callers/graph_callees for call chains and graph_search when you only know part of a name. ' +
  'Before changing a public signature or moving code, run graph_impact (which files to edit) or graph_affected (which files and tests a change reaches). ' +
  'The graph updates itself after your edits. ' +
  'If a tool says the project is not indexed or graph access is disabled, use your normal tools.';
