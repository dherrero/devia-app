import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createToolUsageStore } from './tool-usage-store';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));

describe('tool usage store (S-48)', () => {
  it('has an empty summary when nothing was recorded', () => {
    expect(createToolUsageStore(tmp()).summary()).toEqual({ total: 0, byTool: {}, byAgent: {}, lastAt: null });
  });

  it('counts every concurrent record by tool and agent', async () => {
    const dir = tmp();
    const a = createToolUsageStore(dir);
    const b = createToolUsageStore(dir); // a second MCP process
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        Promise.resolve().then(() => (i % 2 ? a : b).record({ tool: i % 4 ? 'graph_explore' : 'graph_node', agent: 'claude', at: i })),
      ),
    );
    const s = a.summary();
    expect(s.total).toBe(200);
    expect(s.byTool['graph_explore']! + s.byTool['graph_node']!).toBe(200);
    expect(s.byAgent).toEqual({ claude: 200 });
    expect(s.lastAt).toBe(199);
  });

  it('never throws when the directory cannot be written', () => {
    const dir = tmp();
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const store = createToolUsageStore(path.join(blocker, 'sub')); // a path under a regular file
    expect(() => store.record({ tool: 'graph_node', agent: null, at: 1 })).not.toThrow();
    expect(store.summary().total).toBe(0);
  });

  it('skips corrupt lines', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'tool-usage.jsonl'), '{"tool":"graph_node","agent":null,"at":5}\nnot json\n');
    expect(createToolUsageStore(dir).summary()).toMatchObject({ total: 1, byAgent: { unknown: 1 }, lastAt: 5 });
  });
});
