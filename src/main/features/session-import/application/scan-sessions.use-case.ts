import * as path from 'node:path';
import type { ConfigRepository, SessionStore } from '../../../shared/ports';
import { isPathContained } from '../../../shared/workspace-paths';
import type { ImportSource } from '../domain/ports';
import type { ChatMessage } from '../../../../shared/domain/chat';
import type {
  ImportableAgent,
  ImportableProject,
  ImportableSession,
} from '../../../../shared/domain/session-import';

/**
 * Discovers CLI-agent sessions that map to a project inside the configured
 * Devia workspace, so the user can import them. A session's project is taken
 * from the transcript's `cwd` (never a lossy directory name); only sessions
 * whose `cwd` is contained in `workspaceRoot` are offered (v1 scope). Results
 * are grouped by agent → project.
 */
export class ScanSessionsUseCase {
  constructor(private readonly deps: {
    config: ConfigRepository;
    sessions: SessionStore;
    sources: readonly ImportSource[];
  }) {}

  execute(): ImportableAgent[] {
    const { workspaceRoot } = this.deps.config.get();
    if (!workspaceRoot) return [];
    const root = path.resolve(workspaceRoot);

    const agents: ImportableAgent[] = [];
    for (const src of this.deps.sources) {
      if (!src.reader.available()) continue;

      const byProject = new Map<string, ImportableProject>();
      // Per-project cache of the native ids Devia already holds, so a session
      // Devia produced itself (random file id, native id in `agentSessionId`)
      // is recognised — not just ones this importer wrote (file id IS native).
      const existingIdsByProject = new Map<string, Set<string>>();

      for (const ref of src.reader.listTranscripts()) {
        const text = src.reader.read(ref.filePath);
        if (text === null) continue;
        const parsed = src.parser.parse(text);
        if (!parsed) continue;

        const cwd = path.resolve(parsed.cwd);
        if (!isPathContained(cwd, root)) continue; // outside the workspace

        const projectPath = path.relative(root, cwd).split(path.sep).join('/');
        const projectName = path.basename(cwd);
        const alreadyImported = this.existingIds(projectPath, existingIdsByProject)
          .has(parsed.agentSessionId);

        const session: ImportableSession = {
          agentId: parsed.agentId,
          sessionId: parsed.agentSessionId,
          resumable: parsed.resumable,
          preview: previewOf(parsed.messages),
          messageCount: parsed.messages.length,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          alreadyImported,
          ...(parsed.title !== undefined && { title: parsed.title }),
        };

        const group = byProject.get(projectPath);
        if (group) {
          group.sessions.push(session);
        } else {
          byProject.set(projectPath, { projectPath, projectName, sessions: [session] });
        }
      }

      const projects = [...byProject.values()];
      for (const p of projects) p.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      projects.sort((a, b) => a.projectName.localeCompare(b.projectName));
      if (projects.length > 0) agents.push({ agentId: src.parser.agentId, projects });
    }

    agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
    return agents;
  }

  /** Native ids already present in a Devia project (cached per call). */
  private existingIds(projectPath: string, cache: Map<string, Set<string>>): Set<string> {
    const cached = cache.get(projectPath);
    if (cached) return cached;
    const ids = new Set<string>();
    for (const s of this.deps.sessions.list(projectPath)) {
      if (s.agentSessionId) ids.add(s.agentSessionId);
      ids.add(s.id); // a session imported by this feature uses the native id as its file id
    }
    cache.set(projectPath, ids);
    return ids;
  }
}

function previewOf(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const text = (firstUser?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '(sin mensajes)';
  return text.length > 80 ? text.slice(0, 77) + '…' : text;
}
