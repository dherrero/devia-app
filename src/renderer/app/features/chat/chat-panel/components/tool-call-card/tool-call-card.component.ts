import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { DvChatStatusBadgeComponent, IconComponent } from '@devia/ui';
import { summarizeToolCall, type ToolSummaryState } from '../../../../../../../shared/domain/tool-summary';
import { isRunScriptTool, summarizeScript } from '../../../../../../../shared/domain/code-mode-summary';
import {
  LucideBrain, LucideCodeXml, LucideLayoutDashboard, LucideLoader, LucideNetwork, LucideWrench, type LucideIcon,
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
  private readonly translate = inject(TranslateService);
  readonly toolCall = input.required<ToolCallRecord>();
  readonly active = input(true);
  /** Calls a sub-agent made under this one (set only on an Agent/Task call). */
  readonly children = input<ToolCallRecord[]>([]);
  readonly collapsed = signal(true);
  /** Once the user opens or folds the card by hand, a sub-agent's progress stops moving it. */
  private userToggled = false;

  constructor() {
    // A sub-agent (or a `run_script`) card stays open while it runs and folds when it ends.
    effect(() => {
      const script = this.script();
      const status = this.toolCall().subagent?.status ?? (script === null ? undefined : script.status === 'running' ? 'running' : 'done');
      const live = this.active();
      if (status === undefined) return;
      untracked(() => {
        // Open only while it really runs: a persisted `running` (run cancelled or
        // reloaded) must not stay open and spinning.
        if (!this.userToggled) this.collapsed.set(!(status === 'running' && live));
      });
    });
  }

  toggleCollapsed(): void {
    this.userToggled = true;
    this.collapsed.update((value) => !value);
  }

  readonly subagent = computed(() => this.toolCall().subagent ?? null);

  /** S-50: a `run_script` call of the code-mode gateway, with the calls the script made. */
  readonly script = computed(() =>
    isRunScriptTool(this.toolCall().name) ? summarizeScript(this.toolCall(), this.children()) : null,
  );

  /** `≈99.5k` once the saving is worth saying; null otherwise (small or unknown). */
  readonly scriptSavings = computed<string | null>(() => {
    const tokens = this.script()?.tokensSavedEstimate ?? null;
    if (tokens === null || tokens < 500) return null;
    return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  });

  /** Suffix of the `tool_card.script_error_*` key for a failed script. */
  readonly scriptErrorKey = computed<'type' | 'runtime' | 'denied' | 'other' | null>(() => {
    switch (this.script()?.status) {
      case 'type_error': return 'type';
      case 'runtime_error': return 'runtime';
      case 'denied': return 'denied';
      case 'error': return 'other';
      default: return null;
    }
  });

  /** `3 tools · 18,598 tokens`-style facts, already localised by the template. */
  readonly subagentToolsCount = computed(() => this.subagent()?.toolUses ?? null);
  readonly subagentTokens = computed(() => {
    const tokens = this.subagent()?.totalTokens;
    return tokens === undefined ? null : tokens.toLocaleString();
  });

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
    if (!parts || this.script() !== null) return null; // the script card says it all itself
    const known = this.assets.mcpServers().find((s) => s.id === parts.serverId);
    return known?.name ?? parts.serverId;
  });

  /** Semantic, translated card title. The raw provider tool name remains
   *  available through the title attribute for diagnostics. */
  readonly displayTitle = computed(() => {
    if (this.script() !== null) return { key: 'tool_card.script_title', params: undefined };
    const info = this.toolDisplay();
    return { key: info.titleKey, params: info.titleParams };
  });

  readonly LucideLoader = LucideLoader;

  /** Lucide icon for the tool name; falls back to a generic wrench so every
   *  tool card always shows a leading icon. (REV-AGENT-CORE-014)
   *  Devia's own memory MCP gets a brain icon so its calls read as "memory"
   *  at a glance instead of the generic MCP wrench; the kanban MCP reuses the
   *  same dashboard icon as the right-rail kanban button, and the code graph
   *  MCP the network icon of the /graph rail button. */
  readonly toolIconLucide = computed<LucideIcon>(() => {
    if (this.script() !== null) return LucideCodeXml;
    const serverId = this.mcpParts()?.serverId;
    if (serverId === 'devia-memory') return LucideBrain;
    if (serverId === 'devia-kanban') return LucideLayoutDashboard;
    if (serverId === 'devia-code-graph') return LucideNetwork;
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
    const script = this.script();
    if (script !== null) {
      if (script.status === 'type_error' || script.callCount === 0 && script.status !== 'running') return null;
      const servers = script.servers.join(', ');
      return script.durationMs === null
        ? this.translate.instant('tool_card.script_line_running', { servers, calls: script.callCount })
        : this.translate.instant('tool_card.script_line', { servers, calls: script.callCount, seconds: (script.durationMs / 1000).toFixed(1) });
    }
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
    const described = this.script()?.description;
    if (described) return described;
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
