import * as fs from 'node:fs';
import * as path from 'node:path';

import type { SubAgentImportResult } from '../../../../shared/domain/sub-agents';
import { SubAgentReader, DEVIA_DIR, SUB_AGENTS_SUBDIR } from '../infrastructure/sub-agent-reader';
import { renderSubAgentFile } from '../infrastructure/frontmatter';

/**
 * Project-open import: scans every native sub-agent dir under the
 * project and copies what it finds into `<project>/.devia/sub-agents/`.
 *
 * Re-entrant by design (fix on top of #275 v1): we DO NOT block
 * re-runs with a sentinel file. Idempotency comes from "skip files
 * that already exist in .devia/sub-agents/" — running this on every
 * project open is safe AND it picks up newly-added native files
 * (e.g. the user pulled a branch that introduced
 * `.claude/agents/foo.md` for the first time).
 *
 * The earlier sentinel approach was a UX trap: if Devia ran the
 * scan once when the project had no native dirs, it stamped the
 * sentinel and never re-checked, so files added later never made
 * it into the catalog. Worse, because the sentinel was hidden,
 * the user had no way to know that's why the inspector was empty.
 *
 * The `SENTINEL_FILENAME` constant stays exported so tests can
 * assert against the legacy path and (optionally) clean it up.
 */
export const SENTINEL_FILENAME = '.imported';

export class AutoImportSubAgentsUseCase {
  constructor(private readonly reader: SubAgentReader) {}

  execute(projectPath: string): SubAgentImportResult {
    if (!projectPath || !safeIsDir(projectPath)) {
      return { imported: [], skipped: true };
    }
    const targetDir = path.join(projectPath, DEVIA_DIR, SUB_AGENTS_SUBDIR);

    // Defensive: clean up the legacy sentinel left behind by earlier
    // versions of this use case so users on a stale install don't
    // need to delete it by hand. Best-effort — failures are silent.
    const legacySentinel = path.join(targetDir, SENTINEL_FILENAME);
    try { fs.rmSync(legacySentinel, { force: true }); } catch { /* swallow */ }

    const found = this.reader.scanNative(projectPath);
    if (found.length === 0) {
      return { imported: [], skipped: true };
    }

    fs.mkdirSync(targetDir, { recursive: true });
    const imported: string[] = [];
    for (const sub of found) {
      const file = path.join(targetDir, `${sub.name}.md`);
      // Skip when the file already exists — the user (or a previous
      // run) may have edited it and we don't want to clobber edits.
      // New native files always land on the next scan.
      if (safeIsFile(file)) continue;
      const body = renderSubAgentFile(
        {
          name: sub.name,
          description: sub.description,
          tools: [...sub.tools],
          devia_managed: true,
          ...(sub.model !== undefined && { model: sub.model }),
          ...(sub.maxTurns !== undefined && { maxTurns: sub.maxTurns }),
          ...(sub.readonly !== undefined && { readonly: sub.readonly }),
          agents: [...sub.agents],
        },
        sub.body,
      );
      fs.writeFileSync(file, body, 'utf8');
      imported.push(sub.name);
    }
    return { imported, skipped: false };
  }
}

function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function safeIsFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
