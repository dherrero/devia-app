/**
 * Guard for S-30: the core (this application layer) decides WHAT a run needs
 * and never HOW a given agent receives it — that is each agent's mapper
 * (`features/agents/<id>/`). A literal agent id or an import of a concrete
 * mapper here means agent-specific logic leaked back into the core.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AGENT_DEFS } from '../../cli-adapters/infrastructure/registry';

const APPLICATION_DIR = __dirname;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Code only: comments may name agents when explaining history. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the core is agent-agnostic (S-30)', () => {
  const files = sources(APPLICATION_DIR);
  const ids = AGENT_DEFS.map((d) => d.id);

  it('scans the application layer', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(APPLICATION_DIR, f), f]))('%s names no agent', (_name, file) => {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const literals = ids.filter((id) => new RegExp(`['"\`]${id.replace('-', '\\-')}['"\`]`).test(code));
    expect(literals).toEqual([]);
    expect(code).not.toMatch(/features\/agents\/(?!domain\b)[a-z-]+\/|\.\.\/\.\.\/agents\/(?!domain\b)(claude|pi|opencode)\b/);
  });
});
