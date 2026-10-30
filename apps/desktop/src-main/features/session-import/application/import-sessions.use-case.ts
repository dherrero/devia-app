import * as path from 'node:path';
import type { ConfigRepository, SessionStore } from '../../../shared/ports';
import { isPathContained } from '../../../shared/workspace-paths';
import type { ImportSource } from '../domain/ports';
import type { SessionTranscriptRef } from '../../../../shared/domain/agent-transcript';
import { buildSessionStats } from '../../../../shared/domain/session-stats';
import type { StatsSourceMessage } from '../../../../shared/domain/session-stats';
import type {
  ImportOptions,
  ImportSelection,
  ImportSummary,
} from '../../../../shared/domain/session-import';

/**
 * Persists selected agent transcripts as Devia sessions.
 *
 * The crucial bit: the Devia session id IS the agent's native conversation id
 * and the record is stamped `agentId` + `agentSessionId=<id>`. For a `resumable`
 * agent (Claude `--resume`, Codex `exec resume`) continuing the imported session
 * resumes the real native conversation, so the agent regains the FULL prior
 * context — not just the messages rendered here. For replay agents the same
 * stamp lets the runner re-seed the transcript on the next turn.
 */
export class ImportSessionsUseCase {
  constructor(private readonly deps: {
    config: ConfigRepository;
    sessions: SessionStore;
    sources: readonly ImportSource[];
  }) {}

  execute(selections: readonly ImportSelection[], opts?: ImportOptions): ImportSummary {
    const force = opts?.force === true;
    const summary: ImportSummary = { imported: 0, skipped: 0, failed: 0 };
    if (!Array.isArray(selections) || selections.length === 0) return summary;

    const { workspaceRoot } = this.deps.config.get();
    if (!workspaceRoot) {
      summary.failed = selections.length;
      return summary;
    }
    const root = path.resolve(workspaceRoot);

    const sourceByAgent = new Map(this.deps.sources.map((s) => [s.parser.agentId, s]));
    const refsByAgent = new Map<string, Map<string, SessionTranscriptRef>>();
    const existingIdsByProject = new Map<string, Set<string>>();

    for (const sel of selections) {
      const src = sourceByAgent.get(sel.agentId);
      if (!src) { summary.failed++; continue; }

      // Skip when Devia already has this conversation — either as a file named
      // with the native id (a prior import) OR as one of its own sessions that
      // carries the native id in `agentSessionId`. `force` re-imports anyway.
      if (!force && this.existingIds(sel.projectPath, existingIdsByProject).has(sel.sessionId)) {
        summary.skipped++;
        continue;
      }

      let refs = refsByAgent.get(sel.agentId);
      if (!refs) {
        refs = new Map(src.reader.listTranscripts().map((r) => [r.nativeId, r]));
        refsByAgent.set(sel.agentId, refs);
      }
      const ref = refs.get(sel.sessionId);
      if (!ref) { summary.failed++; continue; }

      const text = src.reader.read(ref.filePath);
      if (text === null) { summary.failed++; continue; }

      const parsed = src.parser.parse(text);
      if (!parsed) { summary.failed++; continue; }

      // Defence: the transcript's own cwd must map to the project we're told to
      // write into — never trust the selection's projectPath blindly.
      const cwd = path.resolve(parsed.cwd);
      if (!isPathContained(cwd, root)) { summary.failed++; continue; }
      const projectPath = path.relative(root, cwd).split(path.sep).join('/');
      if (projectPath !== sel.projectPath) { summary.failed++; continue; }

      try {
        const stats = parsed.messages.length > 0
          ? buildSessionStats({
              messages: parsed.messages as StatsSourceMessage[],
              fallbackAgentId: parsed.agentId,
              now: parsed.updatedAt,
            })
          : undefined;
        this.deps.sessions.save(projectPath, {
          id: parsed.agentSessionId,
          project: projectPath,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          messages: parsed.messages,
          agentId: parsed.agentId,
          agentSessionId: parsed.agentSessionId,
          ...(stats && { stats }),
        });
        summary.imported++;
      } catch {
        summary.failed++;
      }
    }

    return summary;
  }

  /** Native ids already present in a Devia project (cached per call). */
  private existingIds(projectPath: string, cache: Map<string, Set<string>>): Set<string> {
    const cached = cache.get(projectPath);
    if (cached) return cached;
    const ids = new Set<string>();
    for (const s of this.deps.sessions.list(projectPath)) {
      if (s.agentSessionId) ids.add(s.agentSessionId);
      ids.add(s.id);
    }
    cache.set(projectPath, ids);
    return ids;
  }
}
