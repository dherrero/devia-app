import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// @ts-expect-error plain ESM script, no type declarations
import { SKILLS, checkKit, isExcluded, listKitFiles, readPin, treeHash, vendor } from '../scripts/vendor-upstream.mjs';

const REAL_SNAPSHOT = path.resolve(__dirname, '..', 'vendor', 'upstream');

let root: string;
let upstream: string;
let dest: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-vendor-'));
  upstream = path.join(root, 'upstream');
  dest = path.join(root, 'snapshot');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const put = (base: string, rel: string, content = rel) => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** A checkout with the allowlisted skills, plus things the snapshot must leave out. */
function makeUpstream(): string {
  for (const skill of SKILLS as string[]) put(upstream, `skills/${skill}/SKILL.md`);
  for (const rel of [
    'skills/brainstorming/scripts/start-server.sh',
    'skills/systematic-debugging/test-pressure-1.md',
    'skills/systematic-debugging/CREATION-LOG.md',
    'skills/some-other-skill/SKILL.md',
    '.claude-plugin/plugin.json',
    'hooks/hooks.json',
    'README.md',
    'LICENSE',
  ]) put(upstream, rel);
  execFileSync('git', ['init', '-q'], { cwd: upstream });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: upstream });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: upstream });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
}

const writePin = (commit: string) =>
  put(dest, 'VERSION.json', JSON.stringify({ repo: 'https://example.test/skills', tag: 'v1.0.0', commit }));

describe('isExcluded', () => {
  it("drops upstream's own skill-testing material, keeps real skill files", () => {
    expect(isExcluded('skills/systematic-debugging/test-academic.md')).toBe(true);
    expect(isExcluded('skills/systematic-debugging/CREATION-LOG.md')).toBe(true);
    expect(isExcluded('skills/brainstorming/SKILL.md')).toBe(false);
    expect(isExcluded('skills/writing-skills/references/testing-skills-with-subagents.md')).toBe(false);
  });
});

describe('vendor', () => {
  it('copies only the allowlisted skills + license and records the pin hash', () => {
    const commit = makeUpstream();
    writePin(commit);
    const result = vendor({ source: upstream, dest });
    expect(result.commit).toBe(commit);

    const files = listKitFiles(dest) as string[];
    expect(files).toContain('LICENSE');
    expect(files).toContain('skills/brainstorming/scripts/start-server.sh');
    expect(files.filter((f) => f.endsWith('SKILL.md'))).toHaveLength((SKILLS as string[]).length);
    expect(files).not.toContain('skills/systematic-debugging/test-pressure-1.md');
    expect(files).not.toContain('skills/systematic-debugging/CREATION-LOG.md');
    expect(fs.existsSync(path.join(dest, 'skills', 'some-other-skill'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'hooks'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'README.md'))).toBe(false);
    expect(readPin(dest)).toMatchObject({ tag: 'v1.0.0', commit, repo: 'https://example.test/skills' });
    expect(checkKit(dest).sha256).toBe(treeHash(dest));
  });

  it('refuses a checkout that is not at the pinned commit unless the pin is being bumped', () => {
    makeUpstream();
    writePin('0'.repeat(40));
    expect(() => vendor({ source: upstream, dest })).toThrow(/the pin is/);
    expect(vendor({ source: upstream, dest, bumpTag: 'v2.0.0' }).tag).toBe('v2.0.0');
    expect(readPin(dest).tag).toBe('v2.0.0');
  });

  it('refuses a symlink anywhere in the vendored tree', () => {
    const commit = makeUpstream();
    writePin(commit);
    fs.symlinkSync('/etc/hosts', path.join(upstream, 'skills', 'brainstorming', 'link.md'));
    expect(() => vendor({ source: upstream, dest })).toThrow(/symlink/);
  });
});

describe('checkKit', () => {
  it('detects a vendored file edited after the fact', () => {
    const commit = makeUpstream();
    writePin(commit);
    vendor({ source: upstream, dest });
    fs.appendFileSync(path.join(dest, 'skills', 'brainstorming', 'SKILL.md'), '\nedited');
    expect(() => checkKit(dest)).toThrow(/drifted/);
  });
});

describe('the shipped snapshot', () => {
  it('still hashes to its pin (nobody edited an upstream file by hand)', () => {
    expect(() => checkKit(REAL_SNAPSHOT)).not.toThrow();
  });

  it('holds exactly the allowlisted skills and the license', () => {
    expect(fs.existsSync(path.join(REAL_SNAPSHOT, 'LICENSE'))).toBe(true);
    expect(fs.readdirSync(path.join(REAL_SNAPSHOT, 'skills')).sort()).toEqual([...(SKILLS as string[])].sort());
  });
});
