import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { KANBAN_TOOLS } from '../sdd/mcp-server/kanban-tools';
import { MEMORY_TOOLS } from '../memory/mcp-server/memory-tools';
import { UI_TOOL_NAMES } from '../../../shared/domain/ui-tools';
import { parseKitManifest } from './domain/kit-prompt';
// @ts-expect-error plain ESM script, no type declarations
import { checkKit } from '../../../../scripts/build-devia-kit.mjs';

/**
 * Lint of the Devia Method kit (S-39). The skills were rewritten from
 * the library Devia Method started from to speak Devia's own tools; this is what keeps them honest as
 * either side moves: nothing may still point at a file, a tool or a skill that
 * does not exist here, and every tool a skill names must be a real one.
 */
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const KIT = path.join(ROOT, 'resources', 'kits', 'devia-method');
const VENDOR = path.join(ROOT, 'vendor', 'upstream');

function walk(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const next = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, next) : [next];
  });
}

/** The library's name, spelled out here only as two halves so this file does not carry it. */
const NAME = new RegExp(['super', 'powers'].join(''), 'i');

const files = walk(KIT);
const markdown = files.filter((f) => f.endsWith('.md') && f !== 'UPSTREAM.md');
const text = (f: string): string => fs.readFileSync(path.join(KIT, f), 'utf8');
const manifest = parseKitManifest(text('kit.json'));

/** What an agent could still be told to use that Devia does not have. */
const FORBIDDEN = [
  'TodoWrite',
  'AskUserQuestion',
  'PLAN_FILE',
  'progress.md',
  'task-brief',
  'task-start',
  'task-done',
  'sdd-workspace',
  'using-git-worktrees',
  'finishing-a-development-branch',
  'visual-companion',
  'visual companion',
];

describe('the Devia Method kit', () => {
  it('is exactly what the build produces from its manifest and the pinned upstream', () => {
    expect(checkKit(KIT, VENDOR)).toEqual([]);
  });

  it('has a valid manifest whose bootstrap is one of its skills', () => {
    expect(manifest).not.toBeNull();
    expect(manifest?.skills.map((s) => s.name)).toContain(manifest?.bootstrap);
  });

  it('carries no trace of the name of the library it started from, nor a namespaced skill reference', () => {
    const hits = files.filter((f) => f !== 'LICENSE' && NAME.test(text(f)));
    expect(hits).toEqual([]);
    const names = (manifest?.skills ?? []).map((s) => s.name).join('|');
    const namespaced = markdown.filter((f) => new RegExp(`\\b[a-z][a-z0-9-]*:(?:${names})\\b`).test(text(f)));
    expect(namespaced).toEqual([]);
  });

  it.each(FORBIDDEN)('no skill file mentions "%s"', (needle) => {
    const hits = markdown.filter((f) => text(f).includes(needle));
    expect(hits).toEqual([]);
  });

  it('every skill has frontmatter naming its own directory, and its trigger matches the manifest for skills Devia wrote', () => {
    for (const skill of manifest?.skills ?? []) {
      const body = text(`skills/${skill.name}/SKILL.md`);
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1] ?? '';
      expect(front, skill.name).toMatch(new RegExp(`^name:\\s*${skill.name}\\s*$`, 'm'));
      const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^"|"$/g, '');
      expect(description, skill.name).toBeTruthy();
      if (skill.origin !== 'literal') expect(description, `${skill.name} trigger`).toBe(skill.trigger);
    }
  });

  it('names only tools that exist: devia_*, kanban_* and mem_*', () => {
    const real = new Set<string>([
      ...UI_TOOL_NAMES.map((n) => `devia_${n}`),
      ...KANBAN_TOOLS.map((t) => t.name),
      ...MEMORY_TOOLS.map((t) => t.name),
    ]);
    const used = new Map<string, string[]>();
    for (const f of markdown) {
      for (const m of text(f).matchAll(/\b(devia_[a-z_]+|kanban_[a-z_]+|mem_[a-z_]+)\b/g)) {
        const name = m[1] as string;
        used.set(name, [...(used.get(name) ?? []), f]);
      }
    }
    const unknown = [...used.entries()].filter(([name]) => !real.has(name)).map(([name, where]) => `${name} in ${where[0]}`);
    expect(unknown).toEqual([]);
    expect([...used.keys()]).toEqual(expect.arrayContaining(['devia_todo', 'kanban_create_task', 'kanban_close_task', 'mem_save']));
  });

  it('every script a skill tells the agent to run exists in the kit', () => {
    const scripts = new Set(files.filter((f) => /\/scripts\//.test(f)).map((f) => path.basename(f)));
    const missing: string[] = [];
    // writing-skills uses `scripts/tool.sh` as an illustration of how to word a skill, not as a script to run.
    for (const f of markdown.filter((p) => !p.startsWith('skills/writing-skills/'))) {
      for (const m of text(f).matchAll(/scripts\/([A-Za-z0-9_.-]+)/g)) {
        if (!scripts.has(m[1] as string)) missing.push(`${m[1]} in ${f}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every skill another skill tells the agent to load is in the kit', () => {
    const names = new Set(manifest?.skills.map((s) => s.name));
    const missing: string[] = [];
    for (const f of markdown) {
      for (const m of text(f).matchAll(/\b(?:[Ll]oad|[Uu]se|invoke|Invoke)(?: the)? `([a-z]+(?:-[a-z]+)+)`/g)) {
        const name = m[1] as string;
        if (!names.has(name) && !/^(?:task-|review-|scripts)/.test(name)) missing.push(`${name} in ${f}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the bootstrap short: it is in the cached prompt prefix on every turn', () => {
    const body = text(`skills/${manifest?.bootstrap}/SKILL.md`);
    expect(body.length).toBeLessThan(3600);
  });

  it('ships the license and the Claude plugin manifest, and no hooks', () => {
    expect(files).toContain('LICENSE');
    expect(files).toContain('.claude-plugin/plugin.json');
    expect(files.some((f) => f.startsWith('hooks/'))).toBe(false);
  });

  it('keeps every script executable on disk', () => {
    if (process.platform === 'win32') return;
    for (const f of files.filter((p) => /\/scripts\/[^/]+$/.test(p) && !p.endsWith('.ts') && !p.endsWith('.js'))) {
      expect(fs.statSync(path.join(KIT, f)).mode & 0o111, f).not.toBe(0);
    }
  });
});
