import {
  ChangeDetectionStrategy, Component, computed, inject, input, signal,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { DvChatStatusBadgeComponent, IconComponent } from '@devia/ui';
import { summarizeToolCall, type ToolSummaryState } from '../../../../../../../shared/domain/tool-summary';
import {
  LucideBrain, LucideLayoutDashboard, LucideLoader, LucideWrench, type LucideIcon,
} from '@lucide/angular';
import { ProjectAssetsService } from '../../../../../core/services/project-assets.service';
import type { ToolCallRecord } from '../../../../../../../shared/domain/chat';
import { getToolDisplayInfo } from '../../../../../../../shared/domain/tool-display';
import { formatTerminalCommandForDisplay } from '../../../../../../../shared/domain/tool-call.helpers';
import { getToolIcon } from '../../../../../../../shared/domain/tool-icons';
import { extractFilePath, iconNameToLucide, oneLine } from './utils/tool-call-view.utils';
import { ToolTerminalBlockComponent } from './components/tool-terminal-block/tool-terminal-block.component';
import { ToolTodoBlockComponent } from './components/tool-todo-block/tool-todo-block.component';
import { ToolGenericBlockComponent } from './components/tool-generic-block/tool-generic-block.component';
import { ToolDiffSectionComponent } from './components/tool-diff-section/tool-diff-section.component';

@Component({
  selector: 'ds-tool-call-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DvChatStatusBadgeComponent, IconComponent, TranslateModule,
    ToolTerminalBlockComponent, ToolTodoBlockComponent, ToolGenericBlockComponent, ToolDiffSectionComponent,
  ],
  templateUrl: './tool-call-card.component.html',
  styleUrl: './tool-call-card.component.scss',
})
export class ToolCallCardComponent {
  private readonly assets = inject(ProjectAssetsService);
  readonly toolCall = input.required<ToolCallRecord>();
  readonly active = input(true);
  readonly collapsed = signal(true);

  toggleCollapsed(): void {
    this.collapsed.update((value) => !value);
  }

  /**
   * MCP-provided tools come over the wire as `mcp__<serverId>__<tool>`
   * (Claude's convention; other agents follow). When the prefix is
   * present we surface a small chip next to the tool name so the user
   * can tell at a glance which MCP server produced the call (#274).
   */
  readonly toolDisplay = computed(() => getToolDisplayInfo(this.toolCall().name));

  /** Parsed { serverId, tool } when the tool name matches the MCP
   *  prefix; null for vanilla tools (Bash, Read, etc.). */
  readonly mcpParts = computed(() => this.toolDisplay().mcpParts);

  /** The chip label — server display name when known, raw id when not
   *  (e.g. server was removed between turn and re-render). */
  readonly mcpServerLabel = computed<string | null>(() => {
    const parts = this.mcpParts();
    if (!parts) return null;
    const known = this.assets.mcpServers().find((s) => s.id === parts.serverId);
    return known?.name ?? parts.serverId;
  });

  /** Semantic, translated card title. The raw provider tool name remains
   *  available through the title attribute for diagnostics. */
  readonly displayTitle = computed(() => {
    const info = this.toolDisplay();
    return { key: info.titleKey, params: info.titleParams };
  });

  readonly LucideLoader = LucideLoader;

  /** Lucide icon for the tool name; falls back to a generic wrench so every
   *  tool card always shows a leading icon. (REV-AGENT-CORE-014)
   *  Devia's own memory MCP gets a brain icon so its calls read as "memory"
   *  at a glance instead of the generic MCP wrench; the kanban MCP reuses the
   *  same dashboard icon as the right-rail kanban button. */
  readonly toolIconLucide = computed<LucideIcon>(() => {
    const serverId = this.mcpParts()?.serverId;
    if (serverId === 'devia-memory') return LucideBrain;
    if (serverId === 'devia-kanban') return LucideLayoutDashboard;
    const entry = getToolIcon(this.toolCall().name);
    const icon = entry ? iconNameToLucide(entry.iconName) : null;
    return icon ?? LucideWrench;
  });

  /** Contextual status summary (state + i18n key) shared with the Node tests. */
  readonly summary = computed(() => {
    const summary = summarizeToolCall(this.toolCall());
    if (summary.state !== 'running' || this.active()) return summary;
    return { state: 'success' as const, key: 'tool_summary.done' };
  });

  readonly isRunning = computed(() => this.summary().state === 'running');

  readonly statusClass = computed<'running' | 'done' | 'error'>(() => {
    const state: ToolSummaryState = this.summary().state;
    return state === 'success' ? 'done' : state;
  });

  readonly chatBadgeStatus = computed<'running' | 'ok' | 'error'>(() => {
    const state: ToolSummaryState = this.summary().state;
    return state === 'success' ? 'ok' : state;
  });

  /** File-editing tools that can produce a diff snapshot (TS-CLI-10). */
  private static readonly FILE_EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

  /**
   * True when a diff snapshot is available and the tool is a file-editing one.
   * Controls rendering of the collapsible diff section (TS-CLI-10).
   */
  readonly hasDiff = computed(() => {
    const tc = this.toolCall();
    return !!tc.diff?.length && ToolCallCardComponent.FILE_EDITING_TOOLS.has(tc.name);
  });

  /** Clean file path for file-oriented tools, or null (cross-agent shapes). */
  readonly filePathArg = computed<string | null>(() => extractFilePath(this.toolCall()));

  /** One-line argument shown in the collapsed header: the file path, or the
   *  command for shell tools. Truncated so it never wraps the chip. */
  readonly headerArg = computed<string | null>(() => {
    const fp = this.filePathArg();
    if (fp) return oneLine(fp, 80);
    const tc = this.toolCall();
    if (tc.name === 'Bash' || tc.name === 'Execute') {
      const cmd = (tc.input as { command?: unknown } | null)?.command;
      if (typeof cmd === 'string' && cmd.trim()) return oneLine(formatTerminalCommandForDisplay(cmd), 80);
    }
    return null;
  });

  readonly headerArgTitle = computed<string | null>(() => {
    const tc = this.toolCall();
    if (tc.name !== 'Bash' && tc.name !== 'Execute') return null;
    const cmd = (tc.input as { command?: unknown } | null)?.command;
    return typeof cmd === 'string' && cmd.trim() ? cmd : null;
  });

  private static readonly TERMINAL_TOOLS = new Set(['Bash', 'Execute']);

  readonly isTerminalTool = computed(() =>
    ToolCallCardComponent.TERMINAL_TOOLS.has(this.toolCall().name),
  );

  private static readonly TODO_TOOLS = new Set(['TodoWrite', 'ExitPlanMode', 'Plan']);

  readonly isTodoTool = computed(() =>
    ToolCallCardComponent.TODO_TOOLS.has(this.toolCall().name),
  );
}
