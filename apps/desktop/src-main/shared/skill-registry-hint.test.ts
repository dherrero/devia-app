import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSkillRegistryHint } from './skill-registry-hint';

/**
 * Tests for the registry-hint helper the runner consumes (#269).
 *
 * Pure read-side. We create a tiny fixture, drop a registry file in
 * and assert the helper returns a non-empty hint that mentions the
 * canonical path. The opposite case (no file) returns null so the
 * runner can skip the injection entirely.
 */

function makeFixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devia-hint-'));
}

describe('buildSkillRegistryHint', () => {
  let project: string;
  beforeEach(() => { project = makeFixture(); });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it('returns null when projectPath is empty', () => {
    expect(buildSkillRegistryHint('')).toBeNull();
  });

  it('returns null when the registry file does not exist', () => {
    expect(buildSkillRegistryHint(project)).toBeNull();
  });

  it('returns a hint mentioning the registry path when the file exists', () => {
    fs.mkdirSync(path.join(project, '.devia'), { recursive: true });
    fs.writeFileSync(path.join(project, '.devia', 'skill-registry.md'), '# anything\n');
    const hint = buildSkillRegistryHint(project);
    expect(hint).not.toBeNull();
    expect(hint).toContain('.devia/skill-registry.md');
    expect(hint).toContain('SKILL.md');
  });

  it('returns null when the registry path resolves to a directory', () => {
    // Defensive: someone made `.devia/skill-registry.md` a folder.
    fs.mkdirSync(path.join(project, '.devia', 'skill-registry.md'), { recursive: true });
    expect(buildSkillRegistryHint(project)).toBeNull();
  });
});
