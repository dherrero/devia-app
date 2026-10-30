import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MemoryStoreDoc } from '../../../../shared/domain/memory';
import { MemoryStore, parseDoc, freshDoc } from './memory-store';

/**
 * One-shot startup migration for the worktree memory-fragmentation bug.
 *
 * Until the fix in RunInstructionUseCase, the runner handed the EFFECTIVE run
 * cwd to the memory feature as project identity. For isolated sessions that
 * cwd is `<deviaDir>/worktrees/<projectKey>/<sessionId>`, so MemoryStore
 * derived a key unique per session and every session wrote its own orphan
 * `projects/<worktree-key>/memory.json` — invisible to all other sessions and
 * to the Settings panel.
 *
 * This migration folds each orphan store back into its base project's store:
 * the orphan key shape is `<keyForPath(deviaDir/worktrees)>-<baseKey>-<uuid>`,
 * so the base key is recovered by stripping the marker prefix and the session
 * UUID suffix. Merged entries keep their content and timestamps but are
 * re-sequenced onto the base document's id counters. A merged orphan file is
 * renamed to `memory.json.migrated` so the migration is idempotent and the
 * original data stays recoverable. Best-effort throughout: a corrupt or
 * unrecognisable entry is skipped, never fatal.
 */

const SESSION_UUID_SUFFIX =
  /-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface WorktreeMemoryMigrationResult {
  mergedStores: number;
  observations: number;
  sessions: number;
  prompts: number;
}

export function migrateWorktreeMemoryStores(deviaDir: string): WorktreeMemoryMigrationResult {
  const result: WorktreeMemoryMigrationResult = {
    mergedStores: 0,
    observations: 0,
    sessions: 0,
    prompts: 0,
  };
  const projectsDir = path.join(deviaDir, 'projects');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return result;
  }
  const marker = `${MemoryStore.keyForPath(path.join(deviaDir, 'worktrees'))}-`;

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(marker)) continue;
    const rest = entry.name.slice(marker.length);
    const baseKey = rest.replace(SESSION_UUID_SUFFIX, '');
    if (baseKey.length === 0 || baseKey === rest) continue;

    const orphanFile = path.join(projectsDir, entry.name, 'memory.json');
    try {
      if (!fs.existsSync(orphanFile)) continue;
      const orphan = parseDoc(JSON.parse(fs.readFileSync(orphanFile, 'utf8')), 'project');
      if (!orphan) continue;

      if (orphan.observations.length + orphan.sessions.length + orphan.prompts.length === 0) {
        fs.renameSync(orphanFile, `${orphanFile}.migrated`);
        continue;
      }

      const baseFile = path.join(projectsDir, baseKey, 'memory.json');
      let base: MemoryStoreDoc | null = null;
      try {
        base = parseDoc(JSON.parse(fs.readFileSync(baseFile, 'utf8')), 'project');
      } catch {
        base = null;
      }
      const doc = base ?? freshDoc('project');

      for (const obs of orphan.observations) {
        doc.observations.push({ ...obs, id: `obs-${doc.nextObsSeq}` });
        doc.nextObsSeq += 1;
        result.observations += 1;
      }
      for (const ses of orphan.sessions) {
        doc.sessions.push({ ...ses, id: `ses-${doc.nextSessionSeq}` });
        doc.nextSessionSeq += 1;
        result.sessions += 1;
      }
      for (const prm of orphan.prompts) {
        doc.prompts.push({ ...prm, id: `prm-${doc.nextPromptSeq}` });
        doc.nextPromptSeq += 1;
        result.prompts += 1;
      }

      fs.mkdirSync(path.dirname(baseFile), { recursive: true });
      const tmp = `${baseFile}.${process.pid}.migration.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      fs.renameSync(tmp, baseFile);
      fs.renameSync(orphanFile, `${orphanFile}.migrated`);
      result.mergedStores += 1;
    } catch (err: unknown) {
      console.warn(
        `[devia:memory] worktree memory migration failed for ${entry.name}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return result;
}
