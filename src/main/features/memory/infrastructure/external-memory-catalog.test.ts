import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyExternalMemory, scanProjectMcpForMemory } from './external-memory-catalog';

describe('classifyExternalMemory', () => {
  it('matches known memory MCPs by command/args/id', () => {
    expect(classifyExternalMemory({ command: 'engram', args: ['serve'] })?.id).toBe('engram');
    expect(classifyExternalMemory({ id: 'memory', command: 'npx', args: ['mcp-memory-service'] })?.id).toBe('mcp-memory-service');
    expect(classifyExternalMemory({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] })?.id).toBe('mcp-server-memory');
    expect(classifyExternalMemory({ args: ['mem0-mcp'] })?.id).toBe('mem0');
  });

  it('never flags Devia\'s own server', () => {
    expect(classifyExternalMemory({ id: 'devia-memory', command: 'node', args: ['server.js'] })).toBeNull();
  });

  it('returns null for unrelated servers and empties', () => {
    expect(classifyExternalMemory({ id: 'github', command: 'npx', args: ['gh-mcp'] })).toBeNull();
    expect(classifyExternalMemory({})).toBeNull();
  });
});

describe('scanProjectMcpForMemory', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mcpscan-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('detects known external memory servers in .mcp.json, de-duplicated', () => {
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        engram: { command: 'engram', args: ['serve'] },
        mem: { command: 'npx', args: ['mcp-memory-service'] },
        gh: { command: 'gh-mcp' },
        'devia-memory': { command: 'node', args: ['server.js'] },
      },
    }));
    const ids = scanProjectMcpForMemory(dir).map((e) => e.id).sort();
    expect(ids).toEqual(['engram', 'mcp-memory-service']);
  });

  it('returns [] when there is no .mcp.json or it is malformed', () => {
    expect(scanProjectMcpForMemory(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{ not json');
    expect(scanProjectMcpForMemory(dir)).toEqual([]);
  });
});
