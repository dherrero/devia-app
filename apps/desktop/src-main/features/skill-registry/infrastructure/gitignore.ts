import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * If a `.gitignore` already exists at the project root, append the
 * registry-dir entry once (idempotent). We deliberately do NOT create
 * a `.gitignore` from scratch — that would surprise users in
 * non-git projects.
 *
 * The marker comment lets future readers (and ourselves) recognise the
 * insertion as Devia-managed without re-adding it on every refresh.
 */
const MARKER = '# Added by Devia — Skill registry (#269)';

export function ensureGitignoreEntry(projectPath: string, entry: string): void {
  const file = path.join(projectPath, '.gitignore');
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    // No .gitignore → don't create one.
    return;
  }

  // Already present (by raw entry or by marker line) — no-op.
  const lines = body.split(/\r?\n/);
  const normalised = entry.endsWith('/') ? entry : `${entry}/`;
  if (lines.some((l) => l.trim() === entry.trim() || l.trim() === normalised.trim())) {
    return;
  }

  const appendChunk = body.endsWith('\n') ? '' : '\n';
  const block = `${appendChunk}\n${MARKER}\n${normalised}\n`;
  try {
    fs.appendFileSync(file, block, 'utf8');
  } catch {
    // Best-effort — a missing `.gitignore` should never break the
    // registry refresh.
  }
}
