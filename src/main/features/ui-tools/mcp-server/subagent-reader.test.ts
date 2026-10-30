import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSubagents, loadSubagent } from './subagent-reader';
import { makeSkillResolver } from './skill-reader';

let dir = '';
const write = (name: string, raw: string): void => fs.writeFileSync(path.join(dir, `${name}.md`), raw, 'utf8');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-subagents-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('sub-agents served through devia_skill', () => {
  it('lists enabled definitions and skips parked ones', () => {
    write('reviewer', '---\nname: reviewer\ndescription: Reviews diffs\nagents: [claude]\n---\nBe strict.');
    write('parked', '---\nname: parked\ndescription: Off\n---\nNo.');
    expect(listSubagents(dir)).toEqual([{ name: 'reviewer', description: 'Reviews diffs' }]);
  });

  it('loads a definition as a role the agent can take on', () => {
    write('reviewer', '---\nname: reviewer\ndescription: Reviews diffs\ntools: [Read, Grep]\nagents: [claude]\n---\nBe strict.');
    const body = loadSubagent(dir, 'reviewer') ?? '';
    expect(body).toContain('# Sub-agent: reviewer');
    expect(body).toContain('Role: Reviews diffs');
    expect(body).toContain('Tools it should use: Read, Grep');
    expect(body.endsWith('Be strict.')).toBe(true);
  });

  it('refuses unsafe names and symlinked definitions', () => {
    const outside = path.join(os.tmpdir(), `devia-outside-${Date.now()}.md`);
    fs.writeFileSync(outside, '---\nname: evil\nagents: [claude]\n---\nX');
    fs.symlinkSync(outside, path.join(dir, 'evil.md'));
    expect(loadSubagent(dir, '../etc/passwd')).toBeNull();
    expect(loadSubagent(dir, 'evil')).toBeNull();
    fs.rmSync(outside, { force: true });
  });

  it('devia_skill lists sub-agents in their own section and loads them by name', async () => {
    write('reviewer', '---\nname: reviewer\ndescription: R\nagents: [claude]\n---\nB');
    const resolve = makeSkillResolver([], dir);
    expect((await resolve('skill', { op: 'list' }))?.text).toBe('Sub-agents (load one to take on its role):\n- reviewer: R');
    expect((await resolve('skill', { op: 'load', name: 'reviewer' }))?.text).toContain('# Sub-agent: reviewer');
    expect(await resolve('skill', { op: 'load', name: 'ghost' })).toMatchObject({ isError: true });
  });
});
