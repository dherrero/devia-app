import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { enterpriseMcpConfigPresent } from './enterprise-mcp-detector';

const tmpRoot = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'ent-mcp-test-'));

describe('enterpriseMcpConfigPresent', () => {
  let root: string;
  let settingsPath: string;

  beforeEach(() => {
    root = tmpRoot();
    settingsPath = path.join(root, 'managed-settings.json');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns true when a managed-settings file declares a non-empty mcpServers', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ mcpServers: { acme: { command: 'acme-mcp' } } }),
    );
    expect(enterpriseMcpConfigPresent({ paths: [settingsPath], env: {} })).toBe(true);
  });

  it('returns false when the file has no mcpServers', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] } }));
    expect(enterpriseMcpConfigPresent({ paths: [settingsPath], env: {} })).toBe(false);
  });

  it('returns false when mcpServers is an empty object', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: {} }));
    expect(enterpriseMcpConfigPresent({ paths: [settingsPath], env: {} })).toBe(false);
  });

  it('returns false when no candidate file exists', () => {
    expect(
      enterpriseMcpConfigPresent({ paths: [path.join(root, 'nope.json')], env: {} }),
    ).toBe(false);
  });

  it('returns false (never throws) on malformed JSON', () => {
    fs.writeFileSync(settingsPath, '{ not valid json');
    expect(enterpriseMcpConfigPresent({ paths: [settingsPath], env: {} })).toBe(false);
  });

  it('probes the next candidate when the first path is missing', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { a: {} } }));
    expect(
      enterpriseMcpConfigPresent({
        paths: [path.join(root, 'missing.json'), settingsPath],
        env: {},
      }),
    ).toBe(true);
  });

  it('honours the DEVIA_ASSUME_ENTERPRISE_MCP=1 escape hatch (forces true)', () => {
    expect(
      enterpriseMcpConfigPresent({
        paths: [path.join(root, 'missing.json')],
        env: { DEVIA_ASSUME_ENTERPRISE_MCP: '1' },
      }),
    ).toBe(true);
  });

  it('honours DEVIA_ASSUME_ENTERPRISE_MCP=0 (forces false even if a config exists)', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { a: {} } }));
    expect(
      enterpriseMcpConfigPresent({
        paths: [settingsPath],
        env: { DEVIA_ASSUME_ENTERPRISE_MCP: '0' },
      }),
    ).toBe(false);
  });

  describe('standalone managed-mcp.json (exclusive control)', () => {
    let mcpPath: string;

    beforeEach(() => {
      mcpPath = path.join(root, 'managed-mcp.json');
    });

    it('returns true when managed-mcp.json declares a non-empty mcpServers', () => {
      fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { acme: { command: 'acme-mcp' } } }));
      expect(enterpriseMcpConfigPresent({ mcpPaths: [mcpPath], env: {} })).toBe(true);
    });

    it('returns true even when managed-mcp.json has an EMPTY mcpServers (MCP disabled, policy still active)', () => {
      fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
      expect(enterpriseMcpConfigPresent({ mcpPaths: [mcpPath], env: {} })).toBe(true);
    });

    it('returns false when managed-mcp.json lacks an mcpServers key', () => {
      fs.writeFileSync(mcpPath, JSON.stringify({ something: 'else' }));
      expect(enterpriseMcpConfigPresent({ mcpPaths: [mcpPath], env: {} })).toBe(false);
    });

    it('returns false (never throws) on malformed managed-mcp.json', () => {
      fs.writeFileSync(mcpPath, '{ not valid json');
      expect(enterpriseMcpConfigPresent({ mcpPaths: [mcpPath], env: {} })).toBe(false);
    });

    it('falls back to managed-settings.json when managed-mcp.json is missing', () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { a: {} } }));
      expect(
        enterpriseMcpConfigPresent({
          mcpPaths: [path.join(root, 'missing-mcp.json')],
          paths: [settingsPath],
          env: {},
        }),
      ).toBe(true);
    });

    it('managed-mcp.json (empty) wins even when managed-settings.json has no mcpServers', () => {
      fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
      fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] } }));
      expect(
        enterpriseMcpConfigPresent({ mcpPaths: [mcpPath], paths: [settingsPath], env: {} }),
      ).toBe(true);
    });
  });
});
