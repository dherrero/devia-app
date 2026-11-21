/** One tool of one MCP server, as the gateway sees it. */
export interface CatalogTool {
  server: string;
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  /** Already classified: `true` only when the call may run in a read-only script. */
  readOnly: boolean;
}

export type ToolAccess = 'read' | 'write';

/**
 * Read or write? Only an explicit `readOnlyHint: true` counts as read: a server
 * that sets no annotation is treated as a write (S-50). The hint is advisory, so
 * the user can override it per tool.
 */
export function classifyTool(
  annotations: { readOnlyHint?: boolean } | undefined,
  override?: ToolAccess,
): ToolAccess {
  if (override !== undefined) return override;
  return annotations?.readOnlyHint === true ? 'read' : 'write';
}
