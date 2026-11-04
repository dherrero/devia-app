import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ConfigRepository } from '../../shared/ports';
import type { DeviaConfig } from '../../../shared/domain/config';
import { buildStarterKitsFeature } from './index';
import { buildSuperpowersProtocol, wrapBootstrap } from './domain/superpowers-protocol';
import { hashKitTree, materializeKit, readKitPin } from './infrastructure/kit-materializer';
import { detectNativeSuperpowers } from './infrastructure/native-detector';

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
  unlock(path.join(deviaDir, 'kits', 'superpowers'));
  fs.rmSync(root, { recursive: true, force: true });
});

const put = (base: string, rel: string, content: string): void => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** A tiny but valid bundled kit with a correct pin. */
function makeBundle(tag = 'v1.0.0'): string {
  const dir = path.join(bundled, 'superpowers');
  fs.rmSync(dir, { recursive: true, force: true });
  put(dir, 'skills/using-superpowers/SKILL.md', '---\nname: using-superpowers\ndescription: x\n---\n\nUSE SKILLS.');
  put(dir, 'skills/brainstorming/SKILL.md', '---\nname: brainstorming\n---\nB');
  put(dir, 'skills/brainstorming/scripts/go', '#!/usr/bin/env bash\necho hi\n');
  put(dir, 'hooks/session-start', 'echo start');
  put(dir, '.claude-plugin/plugin.json', '{}');
  put(dir, 'LICENSE', 'MIT');
  put(dir, 'VERSION.json', JSON.stringify({ repo: 'r', tag, commit: 'c'.repeat(40), sha256: hashKitTree(dir) }));
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
  it('copies the bundle with read-only files, keeps scripts and hooks executable, and is idempotent', () => {
    const src = makeBundle();
    const first = materializeKit(src, path.join(deviaDir, 'kits', 'superpowers'));
    expect(path.basename(first.dir)).toMatch(/^v1\.0\.0-[0-9a-f]{12}$/);
    expect(fs.existsSync(path.join(first.dir, 'skills', 'brainstorming', 'SKILL.md'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(first.dir, 'skills', 'brainstorming', 'SKILL.md')).mode & 0o222).toBe(0);
      expect(fs.statSync(path.join(first.dir, 'hooks', 'session-start')).mode & 0o111).not.toBe(0);
      expect(fs.statSync(path.join(first.dir, 'skills', 'brainstorming', 'scripts', 'go')).mode & 0o111).not.toBe(0);
    }
    const marker = fs.statSync(path.join(first.dir, '.devia-managed.json')).mtimeMs;
    const second = materializeKit(src, path.join(deviaDir, 'kits', 'superpowers'));
    expect(second.dir).toBe(first.dir);
    expect(fs.statSync(path.join(second.dir, '.devia-managed.json')).mtimeMs).toBe(marker);
  });

  it('prunes older versions when a new one lands', () => {
    const target = path.join(deviaDir, 'kits', 'superpowers');
    const old = materializeKit(makeBundle('v1.0.0'), target);
    put(path.join(bundled, 'superpowers'), 'skills/extra/SKILL.md', 'E');
    fs.writeFileSync(
      path.join(bundled, 'superpowers', 'VERSION.json'),
      JSON.stringify({ repo: 'r', tag: 'v1.1.0', commit: 'd'.repeat(40), sha256: hashKitTree(path.join(bundled, 'superpowers')) }),
    );
    const next = materializeKit(path.join(bundled, 'superpowers'), target);
    expect(next.dir).not.toBe(old.dir);
    expect(fs.readdirSync(target)).toEqual([path.basename(next.dir)]);
  });

  it('refuses a bundle that no longer matches its pin', () => {
    const src = makeBundle();
    fs.appendFileSync(path.join(src, 'skills', 'brainstorming', 'SKILL.md'), 'tampered');
    expect(() => materializeKit(src, path.join(deviaDir, 'kits', 'superpowers'))).toThrow(/does not match its pin/);
  });

  it('refuses a bundle with no pin', () => {
    const src = makeBundle();
    fs.rmSync(path.join(src, 'VERSION.json'));
    expect(readKitPin(src)).toBeNull();
    expect(() => materializeKit(src, path.join(deviaDir, 'kits', 'superpowers'))).toThrow(/no valid VERSION.json/);
  });

  it('hashes the shipped kit exactly as the vendoring script pinned it', () => {
    const real = path.join(REAL_KITS, 'superpowers');
    expect(hashKitTree(real)).toBe(readKitPin(real)?.sha256);
  });
});

describe('detectNativeSuperpowers', () => {
  const cwd = (): string => path.join(root, 'project');

  it('is false on a clean machine', () => {
    expect(detectNativeSuperpowers('claude', home, cwd())).toBe(false);
  });

  it('sees the Claude plugin, by manifest or by cache folder', () => {
    put(home, '.claude/plugins/installed_plugins.json', '{"plugins":{"superpowers@claude-plugins-official":[]}}');
    expect(detectNativeSuperpowers('claude', home, cwd())).toBe(true);
    expect(detectNativeSuperpowers('codex', home, cwd())).toBe(false);
  });

  it('sees using-superpowers in the agent\'s own skill dirs, project or global', () => {
    put(home, '.codex/skills/using-superpowers/SKILL.md', 'x');
    expect(detectNativeSuperpowers('codex', home, cwd())).toBe(true);
    expect(detectNativeSuperpowers('gemini', home, cwd())).toBe(false);
    put(cwd(), '.agents/skills/using-superpowers/SKILL.md', 'x');
    expect(detectNativeSuperpowers('gemini', home, cwd())).toBe(true);
  });
});

describe('superpowers protocol', () => {
  it('wraps the bootstrap without its frontmatter and tells the agent it is already loaded', () => {
    const wrapped = wrapBootstrap('---\nname: using-superpowers\n---\nBODY');
    expect(wrapped).toContain('<EXTREMELY_IMPORTANT>');
    expect(wrapped).toContain('BODY');
    expect(wrapped).not.toContain('name: using-superpowers');
    expect(wrapped).toContain('already loaded');
  });

  it('maps every action the skills use to a Devia tool and forbids touching worktrees', () => {
    const p = buildSuperpowersProtocol('/kit/dir');
    for (const tool of ['devia_ask_user', 'devia_todo', 'devia_skill', 'kanban_create_spec', 'kanban_create_task', 'devia_plan_approve', 'devia_request_review']) {
      expect(p).toContain(tool);
    }
    expect(p).toContain('/kit/dir/skills');
    expect(p).toMatch(/invoke `brainstorming` FIRST/);
    expect(p).toMatch(/never create, switch or remove a git worktree/i);
    expect(p).toMatch(/even if its path contains `worktrees\/`/);
  });

  it('stays small: it rides in the cached prefix of every turn', () => {
    expect(buildSuperpowersProtocol('/Users/someone/.devia-app/kits/superpowers/v7.0.1-abcdef123456').length).toBeLessThan(3200);
  });
});

describe('StarterKitsPort', () => {
  const ctx = (agentId = 'codex') => ({ agentId, projectCheckout: '/ws/app', cwd: '/ws/app' });

  it('delivers nothing until the user (or a fresh install) enables the kit', () => {
    const { built } = build(fakeConfig({ workspaceRoot: '/ws' }));
    makeBundle();
    expect(built.port.resolve(ctx())).toBeNull();
  });

  it('seeds ON for a fresh install (no workspace yet) but never for an existing one', () => {
    makeBundle();
    const fresh = build(fakeConfig({ workspaceRoot: '' }));
    expect(fresh.config.current.starterKits?.superpowers?.enabled).toBe(true);
    const existing = build(fakeConfig({ workspaceRoot: '/ws' }));
    expect(existing.config.current.starterKits?.superpowers?.enabled).toBeUndefined();
  });

  it('delivers the kit with bootstrap, protocol and dirs once enabled', () => {
    makeBundle();
    const { built } = build(fakeConfig({ starterKits: { superpowers: { enabled: true } } }));
    const run = built.port.resolve(ctx());
    expect(run?.id).toBe('superpowers');
    expect(run?.bootstrap).toContain('USE SKILLS.');
    expect(run?.protocol).toContain('devia_skill');
    expect(run?.skillsDir).toBe(path.join(run?.dir ?? '', 'skills'));
  });

  it('honours a per-project override in both directions', () => {
    makeBundle();
    const off = build(fakeConfig({ starterKits: { superpowers: { enabled: true, projects: { '/ws/app': false } } } }));
    expect(off.built.port.resolve(ctx())).toBeNull();
    const on = build(fakeConfig({ starterKits: { superpowers: { enabled: false, projects: { '/ws/app': true } } } }));
    expect(on.built.port.resolve(ctx())).not.toBeNull();
  });

  it('steps aside for an agent that already has Superpowers installed', () => {
    makeBundle();
    put(home, '.codex/skills/using-superpowers/SKILL.md', 'x');
    const { built } = build(fakeConfig({ starterKits: { superpowers: { enabled: true } } }));
    expect(built.port.resolve(ctx('codex'))).toBeNull();
    expect(built.port.resolve(ctx('gemini'))).not.toBeNull();
  });

  it('degrades to "no kit" when the bundle is broken, never throwing into a run', () => {
    const src = makeBundle();
    fs.appendFileSync(path.join(src, 'LICENSE'), 'tampered');
    const { built } = build(fakeConfig({ starterKits: { superpowers: { enabled: true } } }));
    expect(built.port.resolve(ctx())).toBeNull();
    expect(built.status('app').materialized).toBe(false);
  });

  it('set() merges switches without erasing siblings, and status() reports the result', () => {
    makeBundle();
    const { built, config } = build(fakeConfig({ workspaceRoot: '/ws' }));
    built.set({ id: 'superpowers', enabled: true, introSeen: true });
    built.set({ id: 'superpowers', projectPath: 'app', projectEnabled: false });
    expect(config.current.starterKits?.superpowers).toEqual({ enabled: true, introSeen: true, projects: { '/ws/app': false } });
    const view = built.status('app');
    expect(view).toMatchObject({ enabled: true, introSeen: true, projectOverride: false, effective: false, materialized: true, tag: 'v1.0.0' });
    expect(view.skills).toEqual(['brainstorming', 'using-superpowers']);
    built.set({ id: 'superpowers', projectPath: 'app', projectEnabled: null });
    expect(built.status('app')).toMatchObject({ projectOverride: null, effective: true });
  });
});
