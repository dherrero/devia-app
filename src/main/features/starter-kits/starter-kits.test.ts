import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ConfigRepository } from '../../shared/ports';
import type { DeviaConfig } from '../../../shared/domain/config';
import { buildStarterKitsFeature } from './index';
import { buildKitPrompt, parseKitManifest } from './domain/kit-prompt';
import { hashKitTree, materializeKit, readKitPin } from './infrastructure/kit-materializer';
import { detectNativeMethod } from './infrastructure/native-detector';
import { THIRD_PARTY_BOOTSTRAP_SKILLS, THIRD_PARTY_CLAUDE_PLUGIN } from './infrastructure/third-party-methods';

const OTHER_BOOTSTRAP = THIRD_PARTY_BOOTSTRAP_SKILLS[0] as string;

const REAL_KITS = path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'kits');

let root: string;
let deviaDir: string;
let home: string;
let bundled: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-kits-'));
  deviaDir = path.join(root, 'devia');
  home = path.join(root, 'home');
  bundled = path.join(root, 'bundled');
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => {
  const unlock = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    fs.chmodSync(dir, 0o755);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(path.join(dir, e.name));
  };
  unlock(path.join(deviaDir, 'kits'));
  fs.rmSync(root, { recursive: true, force: true });
});

const put = (base: string, rel: string, content: string): void => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const MANIFEST = {
  id: 'devia-method',
  name: 'Devia Method',
  version: '1.0.0',
  bootstrap: 'using-devia',
  upstream: { repo: 'https://example.test/sp', tag: 'v7.0.1', commit: 'c'.repeat(40) },
  skills: [
    { name: 'using-devia', origin: 'own', trigger: 'Start of every conversation.' },
    { name: 'brainstorming', origin: 'derived', trigger: 'Before building anything non-trivial.' },
    { name: 'test-driven-development', origin: 'literal', trigger: 'Implementing any feature.' },
  ],
};

/** A tiny but valid bundled kit with a correct pin. */
function makeBundle(version = '1.0.0'): string {
  const dir = path.join(bundled, 'devia-method');
  fs.rmSync(dir, { recursive: true, force: true });
  put(dir, 'kit.json', JSON.stringify({ ...MANIFEST, version }));
  put(dir, 'skills/using-devia/SKILL.md', '---\nname: using-devia\ndescription: x\n---\n\n# Using Devia Method\n\nLOAD SKILLS FIRST.');
  put(dir, 'skills/brainstorming/SKILL.md', '---\nname: brainstorming\n---\nB');
  put(dir, 'skills/brainstorming/scripts/go', '#!/usr/bin/env bash\necho hi\n');
  put(dir, 'skills/test-driven-development/SKILL.md', 'T');
  put(dir, '.claude-plugin/plugin.json', '{}');
  put(dir, 'LICENSE', 'MIT');
  put(dir, 'VERSION.json', JSON.stringify({ repo: 'r', tag: 'v7.0.1', commit: 'c'.repeat(40), sha256: hashKitTree(dir) }));
  return dir;
}

function fakeConfig(initial: Partial<DeviaConfig> = {}): ConfigRepository & { current: DeviaConfig } {
  const state = { current: { workspaceRoot: '/ws', agentId: 'claude', ...initial } as DeviaConfig };
  return Object.assign(state, {
    get: () => state.current,
    set: (partial: Partial<DeviaConfig>) => (state.current = { ...state.current, ...partial }),
    reload: () => state.current,
    hasWorkspace: () => true,
    configPath: () => path.join(deviaDir, 'devia-app.config.json'),
    deviaDir: () => deviaDir,
  });
}

const build = (config = fakeConfig()) => {
  const built = buildStarterKitsFeature({ config, bundledKitsDir: () => bundled, home: () => home });
  built.feature.register({ ipc: { handle: () => undefined } } as never);
  return { built, config };
};

describe('materializeKit', () => {
  it('copies the bundle with read-only files, keeps scripts executable, and is idempotent', () => {
    const src = makeBundle();
    const first = materializeKit(src, path.join(deviaDir, 'kits', 'devia-method'));
    expect(path.basename(first.dir)).toMatch(/^v7\.0\.1-[0-9a-f]{12}$/);
    expect(fs.existsSync(path.join(first.dir, 'skills', 'brainstorming', 'SKILL.md'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(first.dir, 'skills', 'brainstorming', 'SKILL.md')).mode & 0o222).toBe(0);
      expect(fs.statSync(path.join(first.dir, 'skills', 'brainstorming', 'scripts', 'go')).mode & 0o111).not.toBe(0);
    }
    const marker = fs.statSync(path.join(first.dir, '.devia-managed.json')).mtimeMs;
    const second = materializeKit(src, path.join(deviaDir, 'kits', 'devia-method'));
    expect(second.dir).toBe(first.dir);
    expect(fs.statSync(path.join(second.dir, '.devia-managed.json')).mtimeMs).toBe(marker);
  });

  it('prunes older versions when a new one lands', () => {
    const target = path.join(deviaDir, 'kits', 'devia-method');
    const old = materializeKit(makeBundle('1.0.0'), target);
    const src = path.join(bundled, 'devia-method');
    put(src, 'skills/extra/SKILL.md', 'E');
    fs.writeFileSync(path.join(src, 'VERSION.json'), JSON.stringify({ repo: 'r', tag: 'v7.1.0', commit: 'd'.repeat(40), sha256: hashKitTree(src) }));
    const next = materializeKit(src, target);
    expect(next.dir).not.toBe(old.dir);
    expect(fs.readdirSync(target)).toEqual([path.basename(next.dir)]);
  });

  it('refuses a bundle that no longer matches its pin', () => {
    const src = makeBundle();
    fs.appendFileSync(path.join(src, 'skills', 'brainstorming', 'SKILL.md'), 'tampered');
    expect(() => materializeKit(src, path.join(deviaDir, 'kits', 'devia-method'))).toThrow(/does not match its pin/);
  });

  it('refuses a bundle with no pin', () => {
    const src = makeBundle();
    fs.rmSync(path.join(src, 'VERSION.json'));
    expect(readKitPin(src)).toBeNull();
    expect(() => materializeKit(src, path.join(deviaDir, 'kits', 'devia-method'))).toThrow(/no valid VERSION.json/);
  });

  it('hashes the shipped kit exactly as the build script pinned it', () => {
    const real = path.join(REAL_KITS, 'devia-method');
    expect(hashKitTree(real)).toBe(readKitPin(real)?.sha256);
  });
});

describe('detectNativeMethod', () => {
  const cwd = (): string => path.join(root, 'project');

  it('is false on a clean machine', () => {
    expect(detectNativeMethod('claude', home, cwd())).toBe(false);
  });

  it('sees the Claude plugin, by manifest or by cache folder', () => {
    put(home, '.claude/plugins/installed_plugins.json', `{"plugins":{"${THIRD_PARTY_CLAUDE_PLUGIN}@some-marketplace":[]}}`);
    expect(detectNativeMethod('claude', home, cwd())).toBe(true);
    expect(detectNativeMethod('codex', home, cwd())).toBe(false);
  });

  it("sees another method's bootstrap or this kit's in the agent's own skill dirs, project or global", () => {
    put(home, `.codex/skills/${OTHER_BOOTSTRAP}/SKILL.md`, 'x');
    expect(detectNativeMethod('codex', home, cwd())).toBe(true);
    expect(detectNativeMethod('gemini', home, cwd())).toBe(false);
    put(cwd(), '.agents/skills/using-devia/SKILL.md', 'x');
    expect(detectNativeMethod('gemini', home, cwd())).toBe(true);
  });
});

describe('kit prompt', () => {
  const manifest = parseKitManifest(JSON.stringify(MANIFEST));

  it('rejects a manifest that is not one', () => {
    expect(parseKitManifest('not json')).toBeNull();
    expect(parseKitManifest('{"id":"x"}')).toBeNull();
  });

  it('carries the bootstrap without its frontmatter, says it is already loaded, and indexes the other skills', () => {
    const prompt = buildKitPrompt(manifest!, '---\nname: using-devia\n---\n# Using Devia Method\n\nLOAD SKILLS FIRST.', '/kit/skills');
    expect(prompt).toContain('LOAD SKILLS FIRST.');
    expect(prompt).not.toContain('name: using-devia');
    expect(prompt).toContain('already loaded');
    expect(prompt).toContain('/kit/skills');
    expect(prompt).toContain('- `brainstorming`: Before building anything non-trivial.');
    expect(prompt).not.toContain('- `using-devia`');
  });
});

describe('the shipped kit as the agent receives it', () => {
  it('stays small: it rides in the cached prefix of every turn', () => {
    const dir = path.join(REAL_KITS, 'devia-method');
    const manifest = parseKitManifest(fs.readFileSync(path.join(dir, 'kit.json'), 'utf8'));
    expect(manifest).not.toBeNull();
    const bootstrap = fs.readFileSync(path.join(dir, 'skills', manifest!.bootstrap, 'SKILL.md'), 'utf8');
    const prompt = buildKitPrompt(manifest!, bootstrap, '/Users/someone/.devia-app/kits/devia-method/v7.0.1-abcdef123456/skills');
    expect(prompt.length).toBeLessThan(5000);
  });
});

describe('StarterKitsPort', () => {
  const ctx = (agentId = 'codex') => ({ agentId, projectCheckout: '/ws/app', cwd: '/ws/app' });

  it('delivers nothing until the user (or a fresh install) enables the kit', () => {
    makeBundle();
    const { built } = build(fakeConfig({ workspaceRoot: '/ws' }));
    expect(built.port.resolve(ctx())).toBeNull();
  });

  it('seeds ON for a fresh install (no workspace yet) but never for an existing one', () => {
    makeBundle();
    const fresh = build(fakeConfig({ workspaceRoot: '' }));
    expect(fresh.config.current.starterKits?.['devia-method']?.enabled).toBe(true);
    const existing = build(fakeConfig({ workspaceRoot: '/ws' }));
    expect(existing.config.current.starterKits?.['devia-method']?.enabled).toBeUndefined();
  });

  it('delivers the kit prompt and dirs once enabled', () => {
    makeBundle();
    const { built } = build(fakeConfig({ starterKits: { 'devia-method': { enabled: true } } }));
    const run = built.port.resolve(ctx());
    expect(run?.id).toBe('devia-method');
    expect(run?.prompt).toContain('LOAD SKILLS FIRST.');
    expect(run?.prompt).toContain('- `test-driven-development`');
    expect(run?.skillsDir).toBe(path.join(run?.dir ?? '', 'skills'));
  });

  it('honours a per-project override in both directions', () => {
    makeBundle();
    const off = build(fakeConfig({ starterKits: { 'devia-method': { enabled: true, projects: { '/ws/app': false } } } }));
    expect(off.built.port.resolve(ctx())).toBeNull();
    const on = build(fakeConfig({ starterKits: { 'devia-method': { enabled: false, projects: { '/ws/app': true } } } }));
    expect(on.built.port.resolve(ctx())).not.toBeNull();
  });

  it('steps aside for an agent that already has a development method installed', () => {
    makeBundle();
    put(home, `.codex/skills/${OTHER_BOOTSTRAP}/SKILL.md`, 'x');
    const { built } = build(fakeConfig({ starterKits: { 'devia-method': { enabled: true } } }));
    expect(built.port.resolve(ctx('codex'))).toBeNull();
    expect(built.port.resolve(ctx('gemini'))).not.toBeNull();
  });

  it('degrades to "no kit" when the bundle is broken, never throwing into a run', () => {
    const src = makeBundle();
    fs.appendFileSync(path.join(src, 'LICENSE'), 'tampered');
    const { built } = build(fakeConfig({ starterKits: { 'devia-method': { enabled: true } } }));
    expect(built.port.resolve(ctx())).toBeNull();
    expect(built.status('app').materialized).toBe(false);
  });

  it('set() merges switches without erasing siblings, and status() reports the result', () => {
    makeBundle();
    const { built, config } = build(fakeConfig({ workspaceRoot: '/ws' }));
    built.set({ id: 'devia-method', enabled: true, introSeen: true });
    built.set({ id: 'devia-method', projectPath: 'app', projectEnabled: false });
    expect(config.current.starterKits?.['devia-method']).toEqual({ enabled: true, introSeen: true, projects: { '/ws/app': false } });
    const view = built.status('app');
    expect(view).toMatchObject({ enabled: true, introSeen: true, projectOverride: false, effective: false, materialized: true, name: 'Devia Method' });
    expect(view.skills.map((s) => `${s.name}:${s.origin}`)).toEqual(['using-devia:own', 'brainstorming:derived', 'test-driven-development:literal']);
    built.set({ id: 'devia-method', projectPath: 'app', projectEnabled: null });
    expect(built.status('app')).toMatchObject({ projectOverride: null, effective: true });
  });
});

describe('migration from a build that stored the kit under another id', () => {
  it("carries the user's choice to devia-method and removes the old files", () => {
    makeBundle();
    put(deviaDir, 'kits/retired-kit/v1-abc/skills/x/SKILL.md', 'old');
    const { config } = build(fakeConfig({ starterKits: { 'retired-kit': { enabled: true, introSeen: true, projects: { '/ws/app': false } } } }));
    expect(config.current.starterKits).toEqual({ 'devia-method': { enabled: true, introSeen: true, projects: { '/ws/app': false } } });
    expect(fs.existsSync(path.join(deviaDir, 'kits', 'retired-kit'))).toBe(false);
    expect(fs.existsSync(path.join(deviaDir, 'kits', 'devia-method'))).toBe(true);
  });

  it('never overwrites a choice already made for devia-method', () => {
    makeBundle();
    const { config } = build(fakeConfig({ starterKits: { 'retired-kit': { enabled: false }, 'devia-method': { enabled: true } } }));
    expect(config.current.starterKits).toEqual({ 'devia-method': { enabled: true } });
  });

  it('leaves a clean config alone', () => {
    makeBundle();
    const { config } = build(fakeConfig({ starterKits: { 'devia-method': { enabled: true } } }));
    expect(config.current.starterKits).toEqual({ 'devia-method': { enabled: true } });
  });
});
