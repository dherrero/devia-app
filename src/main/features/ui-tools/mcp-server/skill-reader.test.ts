import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_SKILL_BYTES, listSkills, loadSkill, makeSkillResolver } from './skill-reader';

let root = '';
let skillsDir = '';

function writeSkill(name: string, body: string): void {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-skills-'));
  skillsDir = path.join(root, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listSkills', () => {
  it('lists each skill with its frontmatter description', () => {
    writeSkill('electron', '---\nname: electron\ndescription: Build desktop apps\n---\n\n# Body');
    writeSkill('angular', '---\ndescription: Angular guidelines\n---\n');

    expect(listSkills([skillsDir])).toEqual([
      { name: 'angular', description: 'Angular guidelines' },
      { name: 'electron', description: 'Build desktop apps' },
    ]);
  });

  it('falls back to the first prose line when there is no frontmatter', () => {
    writeSkill('plain', '# Title\n\nDoes a useful thing.\n');

    expect(listSkills([skillsDir])[0]?.description).toBe('Does a useful thing.');
  });

  it('returns an empty list for a missing directory, never throwing', () => {
    expect(listSkills([path.join(root, 'nope')])).toEqual([]);
  });

  it('skips directories with no SKILL.md', () => {
    fs.mkdirSync(path.join(skillsDir, 'empty'), { recursive: true });

    expect(listSkills([skillsDir])).toEqual([]);
  });
});

describe('nested collections — the layout that actually exists on disk', () => {
  function writeNested(collection: string, name: string, body: string): void {
    const dir = path.join(skillsDir, collection, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  }

  it('finds skills inside a collection folder, not just at the top level', () => {
    // Found by running the tool for real: this repo's root has
    // `angular-developer` directly plus 40 more inside a `skills/` bundle.
    // Scanning one level reported 1 of 41.
    writeSkill('angular-developer', '---\ndescription: Angular\n---');
    writeNested('skills', 'mat-button', '---\ndescription: Material button\n---');
    writeNested('skills', 'mat-card', '---\ndescription: Material card\n---');

    expect(listSkills([skillsDir]).map((s) => s.name)).toEqual([
      'angular-developer',
      'mat-button',
      'mat-card',
    ]);
  });

  it('loads a nested skill by its bare name', () => {
    writeNested('skills', 'mat-button', 'NESTED BODY');

    expect(loadSkill([skillsDir], 'mat-button')).toBe('NESTED BODY');
  });

  it('a top-level skill shadows a same-named one inside a collection', () => {
    writeSkill('electron', 'TOP');
    writeNested('bundle', 'electron', 'NESTED');

    expect(listSkills([skillsDir]).filter((s) => s.name === 'electron')).toHaveLength(1);
    expect(loadSkill([skillsDir], 'electron')).toBe('TOP');
  });

  it('does not descend a second level — a collection of collections is not a thing', () => {
    const deep = path.join(skillsDir, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'SKILL.md'), 'TOO DEEP', 'utf8');

    expect(listSkills([skillsDir])).toEqual([]);
  });

  it('skips a symlinked skill directory — it could point anywhere on the host', () => {
    // The repo root has exactly this: a `web-design-guidelines` symlink to a
    // Linux path, dangling on a macOS machine.
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'SKILL.md'), 'OUTSIDE', 'utf8');
    fs.symlinkSync(outside, path.join(skillsDir, 'linked'));

    expect(listSkills([skillsDir])).toEqual([]);
    expect(loadSkill([skillsDir], 'linked')).toBeNull();
  });

  it('survives a dangling symlink without throwing', () => {
    fs.symlinkSync(path.join(root, 'does-not-exist'), path.join(skillsDir, 'dangling'));

    expect(() => listSkills([skillsDir])).not.toThrow();
    expect(listSkills([skillsDir])).toEqual([]);
  });
});

describe('loadSkill — guards', () => {
  it('returns the body of a real skill', () => {
    writeSkill('electron', 'CONTENT');
    expect(loadSkill([skillsDir], 'electron')).toBe('CONTENT');
  });

  it('refuses a traversal attempt', () => {
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'SECRET', 'utf8');

    expect(loadSkill([skillsDir], '..')).toBeNull();
    expect(loadSkill([skillsDir], '../..')).toBeNull();
    expect(loadSkill([skillsDir], 'a/../../b')).toBeNull();
  });

  it('refuses a name with separators or odd characters', () => {
    expect(loadSkill([skillsDir], 'a/b')).toBeNull();
    expect(loadSkill([skillsDir], 'a b')).toBeNull();
    expect(loadSkill([skillsDir], '')).toBeNull();
  });

  it('refuses a symlinked SKILL.md, which could point anywhere on the host', () => {
    const secret = path.join(root, 'secret.md');
    fs.writeFileSync(secret, 'SECRET', 'utf8');
    const dir = path.join(skillsDir, 'evil');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(secret, path.join(dir, 'SKILL.md'));

    expect(loadSkill([skillsDir], 'evil')).toBeNull();
  });

  it('truncates an oversized skill instead of refusing it', () => {
    writeSkill('huge', 'x'.repeat(MAX_SKILL_BYTES + 500));
    const body = loadSkill([skillsDir], 'huge') as string;

    expect(body).toContain('[truncated by Devia');
    expect(body.length).toBeLessThan(MAX_SKILL_BYTES + 200);
  });
});

describe('makeSkillResolver', () => {
  it('ignores every tool but skill, so the rest reach the rendezvous', async () => {
    const resolve = makeSkillResolver([skillsDir]);
    expect(await resolve('confirm', {})).toBeNull();
    expect(await resolve('ask_user', {})).toBeNull();
  });

  it('lists on op:list and loads on op:load', async () => {
    writeSkill('electron', '---\ndescription: Desktop apps\n---\nBODY');
    const resolve = makeSkillResolver([skillsDir]);

    expect((await resolve('skill', { op: 'list' }))?.text).toContain('electron: Desktop apps');
    expect((await resolve('skill', { op: 'load', name: 'electron' }))?.text).toContain('BODY');
  });

  it('reports a readable error rather than crashing on a bad request', async () => {
    const resolve = makeSkillResolver([skillsDir]);

    expect(await resolve('skill', { op: 'load' })).toMatchObject({ isError: true });
    expect(await resolve('skill', { op: 'load', name: 'ghost' })).toMatchObject({ isError: true });
    expect(await resolve('skill', null)).toMatchObject({ isError: true });
  });

  it('says so plainly when the project has no skills at all', async () => {
    expect((await makeSkillResolver([skillsDir])('skill', { op: 'list' }))?.text).toContain(
      'No skills are installed',
    );
    expect(await makeSkillResolver([])('skill', { op: 'list' })).toMatchObject({ isError: true });
  });
});

describe('several skill roots (S-30 T-356: every dir Devia manages skills in)', () => {
  it('serves skills from every root, and an earlier root wins a name clash', () => {
    writeSkill('shared', '---\ndescription: project copy\n---\nPROJECT');
    const globalDir = path.join(root, 'home', '.config', 'opencode', 'skills');
    for (const [name, body] of [['shared', '---\ndescription: global copy\n---\nGLOBAL'], ['only-global', 'G']] as const) {
      fs.mkdirSync(path.join(globalDir, name), { recursive: true });
      fs.writeFileSync(path.join(globalDir, name, 'SKILL.md'), body, 'utf8');
    }
    const roots = [skillsDir, globalDir];
    expect(listSkills(roots).map((s) => `${s.name}:${s.description}`)).toEqual(['only-global:G', 'shared:project copy']);
    expect(loadSkill(roots, 'shared')).toContain('PROJECT');
    expect(loadSkill(roots, 'only-global')).toBe('G');
  });
});
