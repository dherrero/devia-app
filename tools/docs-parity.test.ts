import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Docs parity gate. `docs/` is the source of truth for what Devia does and does
 * NOT do (AGENTS.md, "Documentation is part of the change"). This test turns
 * that rule into something a PR cannot skip:
 *
 *   1. every folder in `src/main/features/` has `docs/features/<folder>.md`;
 *   2. every top-level feature page follows the template (11 headings in order,
 *      `Status:` and `Verified:` lines);
 *   3. every feature page is linked from `docs/README.md`;
 *   4. every relative Markdown link in `docs/**` and `AGENTS.md` resolves;
 *   5. every backticked repo path (`src/...`, `tools/...`, ...) in those files
 *      exists, so a rename or delete cannot leave a dead reference behind.
 *
 * Never weaken an assertion to make a build green: update the docs.
 */
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const FEATURES_SRC = path.join(ROOT, 'src', 'main', 'features');
const FEATURE_PAGES = path.join(DOCS, 'features');

/** Folders under `src/main/features/` that are not features (none today). */
const NOT_A_FEATURE: readonly string[] = [];

/** Folder name -> page name when they differ (none today). */
const PAGE_ALIASES: Readonly<Record<string, string>> = {};

const TEMPLATE_HEADINGS: readonly string[] = [
  '## Purpose',
  '## Does',
  '## Does NOT',
  '## Entry points',
  '## IPC / MCP surface',
  '## Persistence',
  '## Config',
  '## Gotchas',
  '## Tests',
  '## Related',
];

const FIX_HINT = 'Update docs/ as AGENTS.md ("Documentation is part of the change") requires.';

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

function featureFolders(): string[] {
  return readdirSync(FEATURES_SRC)
    .filter((name) => statSync(path.join(FEATURES_SRC, name)).isDirectory())
    .filter((name) => !NOT_A_FEATURE.includes(name))
    .sort();
}

function featurePages(): string[] {
  return readdirSync(FEATURE_PAGES)
    .filter((name) => name.endsWith('.md') && name !== '_template.md')
    .sort();
}

function markdownFilesToCheck(): string[] {
  return [...walkMarkdown(DOCS), path.join(ROOT, 'AGENTS.md')];
}

describe('docs parity', () => {
  it('has a docs/features page for every src/main/features folder', () => {
    const missing = featureFolders()
      .map((folder) => `${PAGE_ALIASES[folder] ?? folder}.md`)
      .filter((page) => !existsSync(path.join(FEATURE_PAGES, page)));
    expect(missing, `Missing docs/features pages: ${missing.join(', ')}. ${FIX_HINT}`).toEqual([]);
  });

  it('keeps every feature page on the template', () => {
    const problems: string[] = [];
    for (const page of featurePages()) {
      const text = readFileSync(path.join(FEATURE_PAGES, page), 'utf8');
      if (!/^Status: .+/m.test(text)) problems.push(`${page}: no "Status:" line`);
      if (!/^Verified: .+/m.test(text)) problems.push(`${page}: no "Verified:" line`);
      let from = 0;
      for (const heading of TEMPLATE_HEADINGS) {
        const at = text.split('\n').findIndex((line, i) => i >= from && line.trim() === heading);
        if (at === -1) {
          problems.push(`${page}: heading "${heading}" missing or out of order`);
          break;
        }
        from = at + 1;
      }
    }
    expect(problems, `${problems.join('\n')}\n${FIX_HINT}`).toEqual([]);
  });

  it('lists every feature page in docs/README.md', () => {
    const index = readFileSync(path.join(DOCS, 'README.md'), 'utf8');
    const unlisted = featurePages().filter((page) => !index.includes(`features/${page}`));
    expect(unlisted, `Not in docs/README.md: ${unlisted.join(', ')}. ${FIX_HINT}`).toEqual([]);
  });

  it('resolves every relative Markdown link', () => {
    const broken: string[] = [];
    for (const file of markdownFilesToCheck()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = match[1] ?? '';
        if (/^(https?:|mailto:)/.test(target)) continue;
        if (!existsSync(path.resolve(path.dirname(file), target))) {
          broken.push(`${path.relative(ROOT, file)} -> ${target}`);
        }
      }
    }
    expect(broken, `Broken links:\n${broken.join('\n')}\n${FIX_HINT}`).toEqual([]);
  });

  it('references only repo paths that exist', () => {
    const missing: string[] = [];
    const repoPath = /`((?:src|tools|scripts|resources|build|tests)\/[^`\s]*)`/g;
    for (const file of markdownFilesToCheck()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(repoPath)) {
        // `path:symbol` -> path; skip globs and <placeholders>.
        const raw = (match[1] ?? '').split(/:[A-Za-z_]/)[0] ?? '';
        const candidate = raw.replace(/[.,;)]+$/, '').replace(/\/$/, '');
        if (/[*<>{}]/.test(candidate)) continue;
        const last = candidate.split('/').pop() ?? '';
        if (!last.includes('.') && !(match[1] ?? '').endsWith('/')) continue;
        if (!existsSync(path.join(ROOT, candidate))) {
          missing.push(`${path.relative(ROOT, file)} -> ${candidate}`);
        }
      }
    }
    expect(missing, `Dead path references:\n${missing.join('\n')}\n${FIX_HINT}`).toEqual([]);
  });
});
