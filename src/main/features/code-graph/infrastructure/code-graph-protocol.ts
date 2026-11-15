const PROTOCOL = [
  'Code graph: this project has a live code graph.',
  'Use `graph_explore` first (pass exact symbol names), then `graph_node`, `graph_impact` and `graph_affected`.',
  'They replace grep/find for questions about structure, flow and impact.',
  'The graph updates itself after your edits.',
  'Consult `graph_impact` and `graph_affected` BEFORE changing a public signature.',
].join(' ');

/** Brief prompt guidance, only when THIS run was handed the graph server. */
export function codeGraphProtocol(args: { serverRegistered: boolean }): string | null {
  return args.serverRegistered ? PROTOCOL : null;
}
