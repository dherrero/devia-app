/**
 * Filesystem loader for `<deviaDir>/mcp-servers.json` (REV-AGENT-CORE-004).
 *
 * Tolerates a missing file (returns []), malformed JSON (logs + []), and
 * entries that fail validation (drops them with a warning).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { validateServerConfig } from '../domain/validate';

export function loadMcpServers(deviaDir: string): McpServerConfig[] {
  const file = path.join(deviaDir, 'mcp-servers.json');
  if (!safeIsFile(file)) return [];
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    console.warn(`[mcp] failed to parse ${file}:`, err instanceof Error ? err.message : String(err));
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { servers?: unknown }).servers)) {
    console.warn(`[mcp] ${file} is not an { servers: [...] } object — ignoring.`);
    return [];
  }
  const list = (parsed as { servers: unknown[] }).servers;
  const valid: McpServerConfig[] = [];
  for (const entry of list) {
    const sanitised = validateServerConfig(entry);
    if (sanitised !== null) {
      valid.push(sanitised);
    } else {
      console.warn(`[mcp] invalid server entry in ${file}:`, entry);
    }
  }
  return valid;
}

function safeIsFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
