/**
 * REV-AGENT-CORE-003: tests for the prompt-pack scanner, frontmatter parser,
 * registry, and system-prompt composer.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseFrontmatter } from './domain/frontmatter';
import { PromptPackRegistry } from './domain/registry';
import { scanPromptPacks } from './infrastructure/scanner';
import { composeSystemPrompt } from './application/compose-system-prompt';

function writePack(root: string, id: string, content: string): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'PACK.md');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-prompt-packs-'));
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe('parseFrontmatter', () => {
  it('parses simple key/value pairs', () => {
    const result = parseFrontmatter(
      '---\nname: TDD First\ndescription: Test-driven\n---\nThe body.\n',
    );
    expect(result.meta['name']).toBe('TDD First');
    expect(result.meta['description']).toBe('Test-driven');
    expect(result.body.trim()).toBe('The body.');
  });

  it('parses inline arrays with quoted entries', () => {
    const result = parseFrontmatter(
      '---\ntriggers: ["tdd", test-first, "comma, inside"]\n---\nx\n',
    );
    expect(result.meta['triggers']).toEqual(['tdd', 'test-first', 'comma, inside']);
  });

  it('returns body verbatim when no frontmatter delimiter is present', () => {
    const result = parseFrontmatter('Just body text\nMore body\n');
    expect(result.meta).toEqual({});
    expect(result.body).toBe('Just body text\nMore body\n');
  });

  it('treats unclosed frontmatter as no frontmatter', () => {
    const result = parseFrontmatter('---\nname: foo\nstill open');
    expect(result.meta).toEqual({});
    // Body is the whole input with leading whitespace trimmed.
    expect(result.body.startsWith('---')).toBe(true);
  });

  it('strips surrounding quotes from string values', () => {
    const result = parseFrontmatter('---\nname: "Quoted Name"\n---\nbody\n');
    expect(result.meta['name']).toBe('Quoted Name');
  });

  it('strips BOM from the start of the file', () => {
    const result = parseFrontmatter('﻿---\nname: foo\n---\nbody\n');
    expect(result.meta['name']).toBe('foo');
  });
});

describe('scanPromptPacks', () => {
  it('finds packs under each root with the right source label', () => {
    const userDir = path.join(tmp, 'user');
    const builtInDir = path.join(tmp, 'built-in');
    writePack(userDir, 'tdd', '---\nname: TDD\ndescription: tests first\n---\nBody U\n');
    writePack(builtInDir, 'house', '---\nname: House Style\n---\nBody B\n');

    const packs = scanPromptPacks([
      { dir: userDir, source: 'user' },
      { dir: builtInDir, source: 'built-in' },
    ]);
    expect(packs.length).toBe(2);
    expect(packs.find(p => p.id === 'tdd')?.source).toBe('user');
    expect(packs.find(p => p.id === 'house')?.source).toBe('built-in');
  });

  it('lets user packs win when ids collide with built-ins', () => {
    const userDir = path.join(tmp, 'user');
    const builtInDir = path.join(tmp, 'built-in');
    writePack(userDir, 'shared-id', '---\nname: User Variant\n---\nUser body\n');
    writePack(builtInDir, 'shared-id', '---\nname: Bundled\n---\nBundled body\n');

    const packs = scanPromptPacks([
      { dir: userDir, source: 'user' },
      { dir: builtInDir, source: 'built-in' },
    ]);
    expect(packs.length).toBe(1);
    expect(packs[0]?.source).toBe('user');
    expect(packs[0]?.name).toBe('User Variant');
  });

  it('returns [] when a root does not exist', () => {
    const packs = scanPromptPacks([
      { dir: path.join(tmp, 'missing'), source: 'user' },
    ]);
    expect(packs).toEqual([]);
  });

  it('skips packs with empty bodies', () => {
    const userDir = path.join(tmp, 'user');
    writePack(userDir, 'empty', '---\nname: Empty\n---\n\n');
    const packs = scanPromptPacks([{ dir: userDir, source: 'user' }]);
    expect(packs.length).toBe(0);
  });

  it('falls back to folder name when id is omitted from frontmatter', () => {
    const userDir = path.join(tmp, 'user');
    writePack(userDir, 'pack-folder-name', '---\nname: Just A Name\n---\nbody\n');
    const packs = scanPromptPacks([{ dir: userDir, source: 'user' }]);
    expect(packs[0]?.id).toBe('pack-folder-name');
  });

  it('skips symlinks planted under the prompt-pack root', () => {
    const userDir = path.join(tmp, 'user');
    fs.mkdirSync(userDir, { recursive: true });

    // Write a legitimate pack so we know the scanner still works.
    writePack(userDir, 'legit', '---\nname: Legit\n---\nBody\n');

    // Plant a symlink pointing outside the root.
    const target = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/passwd';
    const link = path.join(userDir, 'evil-link');

    let canSymlink = true;
    try { fs.symlinkSync(target, link, 'dir'); } catch { canSymlink = false; }

    if (!canSymlink) return; // skip gracefully when lacking permissions

    const packs = scanPromptPacks([{ dir: userDir, source: 'user' }]);
    expect(packs.length).toBe(1);
    expect(packs[0]?.id).toBe('legit');
  });
});

describe('PromptPackRegistry', () => {
  it('list() returns summaries without bodies', () => {
    const r = new PromptPackRegistry([
      { id: 'a', name: 'A', description: 'A desc', body: 'A body', source: 'user' },
    ]);
    const summary = r.list()[0];
    expect(summary).toEqual({ id: 'a', name: 'A', description: 'A desc', source: 'user' });
    expect(summary).not.toHaveProperty('body');
  });

  it('getBodies() returns bodies in the requested order, dropping unknown ids', () => {
    const r = new PromptPackRegistry([
      { id: 'a', name: 'A', description: '', body: 'BODY-A', source: 'user' },
      { id: 'b', name: 'B', description: '', body: 'BODY-B', source: 'user' },
    ]);
    expect(r.getBodies(['b', 'a', 'unknown'])).toEqual(['BODY-B', 'BODY-A']);
  });
});

describe('composeSystemPrompt', () => {
  it('returns the baseline when no pack bodies are supplied', () => {
    expect(composeSystemPrompt('BASE', [])).toBe('BASE');
  });

  it('concatenates non-empty bodies with --- dividers after the baseline', () => {
    const composed = composeSystemPrompt('BASE', ['P1', 'P2']);
    expect(composed).toBe('BASE\n\n---\n\nP1\n\n---\n\nP2');
  });

  it('ignores empty / whitespace-only bodies', () => {
    const composed = composeSystemPrompt('BASE', ['   ', 'P1', '']);
    expect(composed).toBe('BASE\n\n---\n\nP1');
  });
});
