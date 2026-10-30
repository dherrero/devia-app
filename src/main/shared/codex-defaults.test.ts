import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureCodexTrust } from './codex-defaults';

const norm = (p: string): string =>
  process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);

describe('ensureCodexTrust', () => {
  let codexHome: string;
  let project: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    env = { CODEX_HOME: codexHome };
  });

  afterEach(() => {
    for (const d of [codexHome, project]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  const configPath = (): string => path.join(codexHome, 'config.toml');

  it('creates the config with a trusted entry when none exists', () => {
    ensureCodexTrust(project, env);
    const text = fs.readFileSync(configPath(), 'utf8');
    expect(text).toContain(`[projects.'${norm(project)}']`);
    expect(text).toContain('trust_level = "trusted"');
    expect(text).toContain('# devia-trust-start');
  });

  it('appends WITHOUT touching existing content', () => {
    const existing = [
      'model = "gpt-5.5"',
      '',
      "[projects.'g:\\other\\proj']",
      'trust_level = "trusted"',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath(), existing, 'utf8');

    ensureCodexTrust(project, env);

    const text = fs.readFileSync(configPath(), 'utf8');
    expect(text.startsWith(existing)).toBe(true);
    expect(text).toContain(`[projects.'${norm(project)}']`);
  });

  it('is idempotent — a second call writes nothing new', () => {
    ensureCodexTrust(project, env);
    const first = fs.readFileSync(configPath(), 'utf8');
    ensureCodexTrust(project, env);
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(first);
  });

  it('respects a user-added entry for the same project (any quoting/case)', () => {
    const key = process.platform === 'win32'
      ? path.resolve(project).toUpperCase()  // codex compares paths case-insensitively on win
      : path.resolve(project);
    fs.writeFileSync(
      configPath(),
      `[projects."${key.replace(/\\/g, '\\\\')}"]\ntrust_level = "untrusted"\n`,
      'utf8',
    );

    ensureCodexTrust(project, env);

    const text = fs.readFileSync(configPath(), 'utf8');
    // The user explicitly marked it (even as untrusted) — Devia must not
    // append a competing entry.
    expect(text).not.toContain('devia-trust-start');
  });

  it('never throws when the codex home is not writable', () => {
    expect(() =>
      ensureCodexTrust(project, { CODEX_HOME: path.join(codexHome, 'missing', '\0bad') }),
    ).not.toThrow();
  });

  it('normalizes the path like codex does on Windows (lowercase)', () => {
    if (process.platform !== 'win32') return;
    ensureCodexTrust(project.toUpperCase(), env);
    const text = fs.readFileSync(configPath(), 'utf8');
    expect(text).toContain(`[projects.'${norm(project)}']`);
    expect(text).not.toContain(project.toUpperCase());
  });
});
