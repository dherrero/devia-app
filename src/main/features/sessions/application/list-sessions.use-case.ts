import type { ProjectRegistry, SessionStore } from '../../../shared/ports';
import type { SessionMeta } from '../../../../shared/domain/session';
import { summarizeSessionStats } from '../../../../shared/domain/session-stats';

/**
 * List every persisted session for a project as lightweight metadata. The
 * sidebar uses this to render the history dropdown — no need to ship the
 * full message arrays until the user clicks a session.
 */
export class ListSessionsUseCase {
  constructor(private readonly deps: {
    registry: ProjectRegistry;
    sessions: SessionStore;
  }) {}

  execute(projectPath: string): SessionMeta[] {
    const all = this.deps.sessions.list(projectPath);
    const activeId = this.deps.registry.find(projectPath)?.activeSessionId ?? null;
    return all.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
      preview: previewOf(s.messages),
      isActive: s.id === activeId,
      ...(s.stats && { stats: summarizeSessionStats(s.stats) }),
      ...(s.agentId !== undefined && { agentId: s.agentId }),
    }));
  }
}

function previewOf(messages: unknown[]): string {
  const firstUser = messages.find((m): m is { role: string; text?: string } =>
    !!m && typeof m === 'object' && (m as { role?: unknown }).role === 'user',
  );
  const text = (firstUser?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '(sin mensajes)';
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}
