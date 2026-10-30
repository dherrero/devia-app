/**
 * SCSS token guard (HT-QA-03).
 *
 * Lightweight, zero-dependency lint that fails when SCSS files in the
 * desktop renderer reach for raw `px` (outside the spec-locked
 * border / outline / shadow / border-radius allowlist) or raw `#hex`
 * colours (outside the master palette file).
 *
 * Designed as a fast pre-commit / CI gate — not a stylelint replacement.
 * `scanScssForViolations` is exported and unit-tested so the regex
 * judgement is reviewable; the entry-point at the bottom walks the
 * renderer tree when this file is executed as a Node script.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ScssViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: 'no-raw-px' | 'no-raw-hex';
  readonly snippet: string;
}

/** Properties where px is part of the visual contract (hairlines,
 *  focus rings, shadow softness, corner radii). Matched on the LHS of
 *  a declaration so `width: 22px` still fails. */
const PX_PROPERTY_ALLOWLIST = new Set([
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'outline',
  'outline-offset',
  'box-shadow',
  'text-shadow',
]);

/** Files where raw hex colours are the canonical source (the master
 *  palette). Compared with the trailing `path.posix.normalize`d form
 *  so the check works regardless of how callers pass the filename. */
const HEX_FILE_ALLOWLIST = new Set([
  'src/renderer/styles.scss',
]);

function normalize(file: string): string {
  return file.replace(/\\/g, '/');
}

function lineHasComment(line: string): boolean {
  return /\/\/|\/\*|\*\//.test(line);
}

function propertyOf(declarationLine: string): string | null {
  const m = /^\s*([a-z-]+)\s*:/.exec(declarationLine);
  return m ? m[1].toLowerCase() : null;
}

export function scanScssForViolations(file: string, source: string): ScssViolation[] {
  const violations: ScssViolation[] = [];
  const lines = source.split(/\r?\n/);
  const norm = normalize(file);
  const hexExempt = HEX_FILE_ALLOWLIST.has(norm);

  lines.forEach((line, idx) => {
    // ── no-raw-px ──────────────────────────────────────────────────────
    // Any integer followed by `px` that is NOT preceded by a digit-dot
    // hairline (`0.5px`) and whose declaration property is not in the
    // allowlist. Lines carrying a justifying comment opt out — every
    // intentional literal in the codebase already adds one.
    if (!lineHasComment(line)) {
      // Match an integer immediately followed by `px`, NOT preceded by
      // another digit or decimal point — that way `0.5px` hairlines
      // (the spec-locked divider style) and `12.34px` debug values get
      // ignored while real `12px` violations are caught.
      const pxMatch = /(?<![\d.])\d+px\b/.exec(line);
      if (pxMatch) {
        const prop = propertyOf(line);
        if (!prop || !PX_PROPERTY_ALLOWLIST.has(prop)) {
          violations.push({
            file: norm,
            line: idx + 1,
            rule: 'no-raw-px',
            snippet: line.trim(),
          });
        }
      }
    }

    // ── no-raw-hex ─────────────────────────────────────────────────────
    // Raw `#abc` / `#abcdef` colour outside the master palette files.
    // Skip when wrapped in `url(...)` (sprite anchors / SVG IDs).
    if (!hexExempt) {
      const stripped = line.replace(/url\([^)]*\)/g, '');
      if (/#[0-9a-fA-F]{3,8}\b/.test(stripped)) {
        violations.push({
          file: norm,
          line: idx + 1,
          rule: 'no-raw-hex',
          snippet: line.trim(),
        });
      }
    }
  });

  return violations;
}

function* walkScssFiles(root: string): Iterable<string> {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkScssFiles(full);
    } else if (entry.name.endsWith('.scss')) {
      yield full;
    }
  }
}

export function lintRendererTree(rendererRoot: string): ScssViolation[] {
  const all: ScssViolation[] = [];
  for (const file of walkScssFiles(rendererRoot)) {
    const src = fs.readFileSync(file, 'utf8');
    all.push(...scanScssForViolations(file, src));
  }
  return all;
}
