import type { AcpAgentProfile } from '../profile';
import { defaultToolName, type AcpToolCallLike } from '../tool-name';

// Verified against Hermes 0.23.0: it names an MCP tool `mcp__editor_<id>_<8 hex>__<tool>`
// where <id> is the server id with every non-alphanumeric turned into `_`; the title may append
// `: <argument>` (e.g. `devia_skill: e2e-skill`), which is not part of the tool name.
const EDITOR_MCP = /^mcp__editor_([A-Za-z0-9_]+?)_[0-9a-f]{8}__([A-Za-z0-9_]+)(?::.*)?$/;

const sanitise = (id: string): string => id.replace(/[^A-Za-z0-9]/g, '_');

function candidates(call: AcpToolCallLike): string[] {
  const out: string[] = [];
  if (typeof call.title === 'string') out.push(call.title);
  for (const source of [call.rawInput, call._meta]) {
    if (source !== null && typeof source === 'object') {
      for (const key of ['name', 'tool', 'toolName']) {
        const value = (source as Record<string, unknown>)[key];
        if (typeof value === 'string') out.push(value);
      }
    }
  }
  return out;
}

function hermesToolName(call: AcpToolCallLike, serverIds: readonly string[]): string {
  for (const candidate of candidates(call)) {
    const match = EDITOR_MCP.exec(candidate);
    if (!match) continue;
    const [, sanitised, tool] = match;
    const id = serverIds.find((s) => sanitise(s) === sanitised);
    if (id !== undefined && tool !== undefined) return `mcp__${id}__${tool}`;
  }
  return defaultToolName(call, serverIds);
}

// continuity and planEnforcement keep the safe values: in plan mode Hermes still writes through its
// `terminal` tool, which never asks permission (only `write_file` does), so no policy can enforce it.
export const hermesProfile: AcpAgentProfile = {
  id: 'hermes',
  args: () => ['acp', '--accept-hooks'],
  continuity: 'replay',
  planEnforcement: 'none',
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  toolName: hermesToolName,
};
