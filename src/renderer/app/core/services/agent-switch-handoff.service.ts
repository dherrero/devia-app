import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { AppStateService } from './app-state.service';
import { ElectronApiService } from './electron-api.service';
import { ToastService } from './toast.service';
import {
  buildHandoffRequestPrompt,
  canRequestHandoffSummary,
  detectPendingHandoff,
} from '../../features/chat/chat-panel/utils/agent-handoff.util';

/**
 * S-2 F3.3/F3.4, shared by every place that changes the agent a session runs
 * with (Settings → global default, footer → project/session agent, S-53).
 */
@Injectable({ providedIn: 'root' })
export class AgentSwitchHandoffService {
  private readonly state = inject(AppStateService);
  private readonly api = inject(ElectronApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /**
   * After a successful agent switch, inform (no confirmation — the base handoff
   * is automatic on the next prompt) when the focused session or other mounted
   * panes belong to a different agent.
   */
  notify(previousAgentId: string, newAgentId: string): void {
    if (previousAgentId === newAgentId) return;
    const pending = detectPendingHandoff({
      newAgentId,
      focusedKey: this.state.focusedSessionKey() ?? this.state.selectedProject(),
      mountedKeys: [...this.state.mountedPaneSessions()],
      chats: this.state.chats(),
    });
    if (!pending) return;
    const agents = this.state.detectedAgents() ?? [];
    const fromLabel = agents.find((a) => a.id === pending.fromAgentId)?.name ?? pending.fromAgentId;
    const others = pending.affectedKeys.length - 1;
    const text = others > 0
      ? (this.translate.instant('toasts.agent_handoff_pending_multi', { from: fromLabel, count: others }) as string)
      : (this.translate.instant('toasts.agent_handoff_pending', { from: fromLabel }) as string);
    // F3.4: offer to ask the PREVIOUS agent for a rich handoff summary — only
    // when it is still operative (detected + selectable + authenticated).
    const action = canRequestHandoffSummary(agents, pending.fromAgentId)
      ? {
          label: this.translate.instant('toasts.agent_handoff_request_action', { from: fromLabel }) as string,
          onAction: () => this.requestSummaryFrom(pending.fromAgentId),
        }
      : undefined;
    this.toast.show(text, { kind: 'warning', durationMs: 10_000, ...(action !== undefined && { action }) });
  }

  /**
   * Run an internal instruction on the FOCUSED session with the PREVIOUS agent
   * (agentIdOverride) so it records a rich handoff summary via mem_session_summary
   * before the new agent's first turn. The run shows in the chat as a normal one
   * (displayText hides the internal prompt).
   */
  requestSummaryFrom(fromAgentId: string): void {
    const base = this.state.selectedProject();
    if (!base) return;
    const focusedPane = this.state.focusedSessionKey();
    const displayText = this.translate.instant('chat.handoff_request_display') as string;
    void this.api.sendInstruction(
      base,
      buildHandoffRequestPrompt(),
      [],
      'apply',
      displayText,
      focusedPane === null
        ? { agentIdOverride: fromAgentId }
        : { runKey: focusedPane, sessionId: focusedPane, isolate: false, agentIdOverride: fromAgentId },
    );
  }
}
