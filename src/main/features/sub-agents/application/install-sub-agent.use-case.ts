import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  SubAgent,
  SubAgentCliId,
  SubAgentInstallResult,
} from '../../../../shared/domain/sub-agents';
import { SUB_AGENT_UNSUPPORTED } from '../../../../shared/domain/sub-agents';
import { SubAgentReader, DEVIA_DIR, SUB_AGENTS_SUBDIR } from '../infrastructure/sub-agent-reader';
import { SubAgentWriter } from '../infrastructure/sub-agent-writer';
import { renderSubAgentFile } from '../infrastructure/frontmatter';
import type { SnapshotCapturer } from '../../../shared/ports';

/**
 * Install / upsert a sub-agent for a project (#275).
 *
 *   1. Validate the request (name slug, supported CLIs).
 *   2. Snapshot the affected files BEFORE writing.
 *   3. Write `<project>/.devia/sub-agents/<name>.md` (source of
 *      truth) with the Devia-managed marker.
 *   4. Sync to each supported CLI via SubAgentWriter. Codex /
 *      DeepSeek are silently skipped — their entries land in the
 *      `skipped[]` list so the renderer can surface a status chip.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class InstallSubAgentUseCase {
  constructor(
    private readonly reader: SubAgentReader,
    private readonly writer: SubAgentWriter,
    private readonly snapshot?: SnapshotCapturer,
  ) {}

  execute(
    projectPath: string,
    entry: SubAgent,
  ): SubAgentInstallResult {
    if (!projectPath || !safeIsDir(projectPath)) {
      return { ok: false, affectedFiles: [], error: 'Proyecto inválido' };
    }
    if (!NAME_PATTERN.test(entry.name)) {
      return {
        ok: false,
        affectedFiles: [],
        error: 'Nombre inválido (sólo a-z0-9_-, ≤ 64 chars, empieza con alfanumérico)',
      };
    }

    // Split agents into supported + skipped (codex / deepseek).
    const supported: SubAgentCliId[] = [];
    const skipped: SubAgentCliId[] = [];
    for (const cli of entry.agents) {
      if (SUB_AGENT_UNSUPPORTED.has(cli)) skipped.push(cli);
      else supported.push(cli);
    }

    // ── 0. Read the previous on-disk state BEFORE any write. ─────
    // The matrix-toggle UX from the modal passes empty body/desc
    // when the user only changes agents; we preserve the existing
    // content in that case. We also need the previous agents[] to
    // figure out which CLIs lost the sub-agent.
    const sourceFile = path.join(
      projectPath, DEVIA_DIR, SUB_AGENTS_SUBDIR, `${entry.name}.md`,
    );
    const previous = this.reader.readOne(sourceFile);
    const previousAgents = (previous?.agents ?? []) as SubAgentCliId[];

    const effectiveBody = entry.body.trim().length > 0
      ? entry.body
      : (previous?.body ?? '');
    const effectiveDescription = entry.description.trim().length > 0
      ? entry.description
      : (previous?.description ?? '');
    const effectiveTools = entry.tools.length > 0
      ? entry.tools
      : (previous?.tools ?? []);
    const normalised: SubAgent = {
      ...entry,
      description: effectiveDescription,
      tools: effectiveTools,
      body: effectiveBody,
      agents: supported,
    };

    // ── 1. Snapshot pre-write. ───────────────────────────────────
    const removed = previousAgents.filter(
      (c) => !supported.includes(c) && !SUB_AGENT_UNSUPPORTED.has(c),
    );
    const targetFiles = this.writer.pathsForSync(normalised, projectPath);
    const removeFiles = this.writer.pathsForRemove(entry.name, removed, projectPath);
    const allFiles = Array.from(new Set([sourceFile, ...targetFiles, ...removeFiles]));

    let snapshotId: string | undefined;
    if (this.snapshot && allFiles.length > 0) {
      try {
        const snap = this.snapshot.execute({
          feature: 'manual',
          reason: `subAgents:install "${entry.name}" for ${supported.join('+')}`,
          paths: allFiles,
          projectPath,
        });
        snapshotId = snap.id;
      } catch (err) {
        console.warn('[sub-agents] snapshot skipped:', (err as Error).message);
      }
    }

    // ── 2. Persist Devia source of truth. ────────────────────────
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    const sotBody = renderSubAgentFile(
      {
        name: entry.name,
        description: effectiveDescription,
        tools: [...effectiveTools],
        devia_managed: true,
        ...(entry.model !== undefined && { model: entry.model }),
        ...(entry.maxTurns !== undefined && { maxTurns: entry.maxTurns }),
        ...(entry.readonly !== undefined && { readonly: entry.readonly }),
        agents: [...entry.agents],
      },
      effectiveBody,
    );
    fs.writeFileSync(sourceFile, sotBody, 'utf8');

    // ── 3. Delete from CLIs that lost the sub-agent. ─────────────
    if (removed.length > 0) {
      this.writer.removeAll(entry.name, removed, projectPath);
    }

    // ── 4. Sync to each selected CLI. ────────────────────────────
    const synced = this.writer.syncAll(normalised, projectPath);

    return {
      ok: true,
      affectedFiles: [sourceFile, ...synced.affectedFiles],
      ...(snapshotId !== undefined && { snapshotId }),
      ...(skipped.length > 0 && { skipped }),
    };
  }
}

function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
