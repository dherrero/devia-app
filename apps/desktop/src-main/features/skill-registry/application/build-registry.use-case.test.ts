import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BuildSkillRegistryUseCase } from './build-registry.use-case';
import type { SkillListReader } from '../../../shared/ports';
import type { ListSkillsResult } from '../../../../shared/domain/skill';

/**
 * Tests for the skill registry builder (#269).
 *
 * The use case is fully driven by a `SkillListReader` fake — no need
 * to spin up the real skill-reader infrastructure. Disk I/O is real
 * (the writer + gitignore helper both touch the project dir) so we
 * isolate each test to a temp dir.
 */

function makeFixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devia-skillreg-'));
}

function fakeReader(result: ListSkillsResult): SkillListReader {
  return { list: () => result };
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('BuildSkillRegistryUseCase — no skills', () => {
  let project: string;
  beforeEach(() => { project = makeFixture(); });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it('returns no-skills and deletes any stale registry file', async () => {
    // Pre-seed a stale file so we can assert it's cleaned up.
    fs.mkdirSync(path.join(project, '.devia'), { recursive: true });
    fs.writeFileSync(path.join(project, '.devia', 'skill-registry.md'), 'stale\n');

    const reader = fakeReader({ project: [], global: [] });
    const useCase = new BuildSkillRegistryUseCase(reader);
    const result = await useCase.refresh(project);

    expect(result.reason).toBe('no-skills');
    expect(fs.existsSync(path.join(project, '.devia', 'skill-registry.md'))).toBe(false);
  });

  it('returns no-project for a missing directory', async () => {
    const reader = fakeReader({ project: [], global: [] });
    const useCase = new BuildSkillRegistryUseCase(reader);
    const result = await useCase.refresh('/this/path/does/not/exist');
    expect(result.reason).toBe('no-project');
  });
});

describe('BuildSkillRegistryUseCase — populated', () => {
  let project: string;
  beforeEach(() => {
    project = makeFixture();
    // A pre-existing .gitignore so we can assert the entry append.
    fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n');
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it('writes a registry with project skills winning dedup over global ones', async () => {
    const reader = fakeReader({
      project: [
        {
          name: 'docs-writer',
          description: 'Trigger: editing docs.',
          absolutePath: `${project}/.agents/skills/docs-writer`,
          scope: 'project',
          agents: ['codex', 'gemini'],
        },
      ],
      global: [
        // Same name — project entry above must win.
        {
          name: 'docs-writer',
          description: 'GLOBAL DESC THAT MUST NOT WIN',
          absolutePath: `${os.homedir()}/.claude/skills/docs-writer`,
          scope: 'global',
          agents: ['claude'],
        },
        // Unique global entry survives.
        {
          name: 'go-testing',
          description: 'Trigger: Go test patterns.',
          absolutePath: `${os.homedir()}/.claude/skills/go-testing`,
          scope: 'global',
          agents: ['claude'],
        },
      ],
    });

    const useCase = new BuildSkillRegistryUseCase(reader);
    const result = await useCase.refresh(project);

    expect(result.reason).toBe('ok');
    const entries = expectPresent(result.snapshot).entries;
    // Sorted by name.
    expect(entries.map((e) => e.name)).toEqual(['docs-writer', 'go-testing']);
    // Project-scope description wins.
    expect(entries[0]?.description).toBe('Trigger: editing docs.');
    expect(entries[0]?.scope).toBe('project');
    expect(entries[1]?.scope).toBe('global');

    // File written.
    const body = fs.readFileSync(path.join(project, '.devia', 'skill-registry.md'), 'utf8');
    expect(body).toContain('| docs-writer |');
    expect(body).toContain('| go-testing |');
    expect(body).not.toContain('GLOBAL DESC THAT MUST NOT WIN');
  });

  it('appends the registry dir to an existing .gitignore exactly once', async () => {
    const reader = fakeReader({
      project: [
        {
          name: 'a',
          description: 'A',
          absolutePath: `${project}/.agents/skills/a`,
          scope: 'project',
          agents: ['codex'],
        },
      ],
      global: [],
    });
    const useCase = new BuildSkillRegistryUseCase(reader);

    await useCase.refresh(project);
    await useCase.refresh(project);

    const ignore = fs.readFileSync(path.join(project, '.gitignore'), 'utf8');
    const matches = ignore.match(/\.devia\//g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('is idempotent — a second refresh leaves the file mtime stable when the input is unchanged', async () => {
    const reader = fakeReader({
      project: [
        {
          name: 'a',
          description: 'A',
          absolutePath: `${project}/.agents/skills/a`,
          scope: 'project',
          agents: ['codex'],
        },
      ],
      global: [],
    });
    const useCase = new BuildSkillRegistryUseCase(reader);

    await useCase.refresh(project);
    const file = path.join(project, '.devia', 'skill-registry.md');
    const mtime1 = fs.statSync(file).mtimeMs;

    // Pause long enough for an mtime tick to land if a rewrite happens.
    await new Promise((r) => setTimeout(r, 25));
    await useCase.refresh(project);

    const mtime2 = fs.statSync(file).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it('escapes pipes in descriptions so the GFM table stays valid', async () => {
    const reader = fakeReader({
      project: [
        {
          name: 'pipey',
          description: 'a | b | c — pipes everywhere',
          absolutePath: `${project}/.agents/skills/pipey`,
          scope: 'project',
          agents: ['codex'],
        },
      ],
      global: [],
    });
    const useCase = new BuildSkillRegistryUseCase(reader);
    const result = await useCase.refresh(project);
    expect(result.reason).toBe('ok');
    const body = fs.readFileSync(expectPresent(result.snapshot).registryPath, 'utf8');
    expect(body).toContain('a \\| b \\| c');
  });

  it('relativises in-project paths and keeps global ones absolute', async () => {
    const reader = fakeReader({
      project: [
        {
          name: 'inside',
          description: 'd',
          absolutePath: path.join(project, '.agents/skills/inside'),
          scope: 'project',
          agents: ['codex'],
        },
      ],
      global: [
        {
          name: 'outside',
          description: 'd',
          absolutePath: '/home/x/.claude/skills/outside',
          scope: 'global',
          agents: ['claude'],
        },
      ],
    });
    const useCase = new BuildSkillRegistryUseCase(reader);
    const result = await useCase.refresh(project);
    const body = fs.readFileSync(expectPresent(result.snapshot).registryPath, 'utf8');
    expect(body).toContain('| .agents/skills/inside |');
    expect(body).toContain('| /home/x/.claude/skills/outside |');
  });
});

describe('BuildSkillRegistryUseCase.status', () => {
  let project: string;
  beforeEach(() => { project = makeFixture(); });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it('returns a snapshot without writing the file', () => {
    const reader = fakeReader({
      project: [
        {
          name: 'a',
          description: 'A',
          absolutePath: `${project}/.agents/skills/a`,
          scope: 'project',
          agents: ['codex'],
        },
      ],
      global: [],
    });
    const useCase = new BuildSkillRegistryUseCase(reader);
    const snap = useCase.status(project);
    expect(snap?.entries.length).toBe(1);
    expect(fs.existsSync(path.join(project, '.devia', 'skill-registry.md'))).toBe(false);
  });

  it('returns null for a missing project', () => {
    const reader = fakeReader({ project: [], global: [] });
    const useCase = new BuildSkillRegistryUseCase(reader);
    expect(useCase.status('')).toBeNull();
    expect(useCase.status('/does/not/exist')).toBeNull();
  });
});
