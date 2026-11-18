import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ToolUsageSummary } from '../../../../shared/domain/code-graph';

export type { ToolUsageSummary };

export interface ToolUsageEntry {
  tool: string;
  agent: string | null;
  at: number;
}

export interface ToolUsageStore {
  record(entry: ToolUsageEntry): void;
  summary(): ToolUsageSummary;
}

const FILE = 'tool-usage.jsonl';
const ROTATED = 'tool-usage.1.jsonl';
/** The log rolls over once it passes this size, so it never grows without bound. */
const ROTATE_BYTES = 1024 * 1024;

/**
 * Counts the agents' calls to the graph tools (S-48). One JSON line per call in
 * the project's graph data dir, appended in a single write: several MCP server
 * processes (one per agent run) log to the same file without losing calls. It
 * is a file of its own, never graph.db (S-44: readers keep READONLY handles).
 * Recording never throws, so a full disk or a read-only dir cannot break a tool.
 */
export function createToolUsageStore(dir: string): ToolUsageStore {
  const file = path.join(dir, FILE);
  const rotated = path.join(dir, ROTATED);
  return {
    record(entry) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        try {
          if (fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, rotated);
        } catch {
          // no file yet
        }
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
      } catch {
        // usage is best effort
      }
    },
    summary() {
      const out: ToolUsageSummary = { total: 0, byTool: {}, byAgent: {}, lastAt: null };
      for (const f of [rotated, file]) {
        let text: string;
        try {
          text = fs.readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        for (const line of text.split('\n')) {
          if (!line) continue;
          let e: Partial<ToolUsageEntry>;
          try {
            e = JSON.parse(line) as Partial<ToolUsageEntry>;
          } catch {
            continue;
          }
          if (typeof e.tool !== 'string' || typeof e.at !== 'number') continue;
          out.total++;
          out.byTool[e.tool] = (out.byTool[e.tool] ?? 0) + 1;
          const agent = typeof e.agent === 'string' ? e.agent : 'unknown';
          out.byAgent[agent] = (out.byAgent[agent] ?? 0) + 1;
          if (out.lastAt === null || e.at > out.lastAt) out.lastAt = e.at;
        }
      }
      return out;
    },
  };
}
