import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { NativeConfigMcpDelivery } from './native-config-mcp';

let project: string;
let home: string;
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-native-mcp-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-native-home-'));
});
afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function server(id: string): McpServerConfig {
  return { id, name: id, command: 'node', args: [`${id}.js`], enabled: true };
}
const delivery = (): NativeConfigMcpDelivery => new NativeConfigMcpDelivery(undefined, () => home);
const readMcp = (): Record<string, Record<string, unknown>> =>
  JSON.parse(fs.readFileSync(path.join(project, 'opencode.json'), 'utf8')).mcp;

describe('NativeConfigMcpDelivery', () => {
  it('writes every Devia server in ONE file write, in the agent shape', () => {
    const out = delivery().deliver('opencode', project, [server('devia-kanban'), server('devia-memory'), server('devia-ui')]);
    expect(out.file).toBe(path.join(project, 'opencode.json'));
    expect(out.deliveredServerIds).toEqual(['devia-kanban', 'devia-memory', 'devia-ui']);
    const mcp = readMcp();
    expect(Object.keys(mcp).sort()).toEqual(['devia-kanban', 'devia-memory', 'devia-ui']);
    expect(mcp['devia-ui']).toMatchObject({ type: 'local', command: ['node', 'devia-ui.js'] });
  });

  it('keeps servers the user added by hand and retires the S-24 devia-ask entry', () => {
    fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({
      mcp: {
        github: { type: 'local', command: ['gh-mcp'] },
        'devia-ask': { type: 'local', command: ['old'], __devia_managed: 'devia-ask' },
      },
    }));
    delivery().deliver('opencode', project, [server('devia-kanban')]);
    expect(Object.keys(readMcp()).sort()).toEqual(['devia-kanban', 'github']);
  });

  it('a later run without a server does not delete it (prune:false)', () => {
    delivery().deliver('opencode', project, [server('devia-kanban'), server('devia-ui')]);
    delivery().deliver('opencode', project, [server('devia-kanban')]);
    expect(Object.keys(readMcp()).sort()).toEqual(['devia-kanban', 'devia-ui']);
  });

  it('delivers nothing to an agent with no project MCP config', () => {
    expect(delivery().deliver('deepseek', project, [server('devia-kanban')])).toEqual({ file: null, deliveredServerIds: [] });
  });

  it('reports an empty delivery when the write fails', () => {
    const failing = new NativeConfigMcpDelivery({ write: () => { throw new Error('EACCES'); } }, () => home);
    expect(failing.deliver('opencode', project, [server('devia-ui')]).deliveredServerIds).toEqual([]);
  });
});
