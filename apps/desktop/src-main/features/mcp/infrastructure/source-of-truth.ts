import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServerConfig, McpServersFile } from '../../../../shared/domain/mcp';

/**
 * Atomic write for the Devia source-of-truth file
 * `(devia|<project>/.devia)/mcp-servers.json` (#272).
 *
 * The runtime registry is the in-memory mirror of this file; writes
 * always go through it so the file shape stays consistent.
 */
export function writeRegistry(file: string, servers: ReadonlyArray<McpServerConfig>): void {
  const body: McpServersFile = { servers: [...servers] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
