/**
 * Human-readable console logger for a single agent run.
 *
 * Replaces the scattered IS_DEV-only debug prints in cli-launcher with a
 * structured, always-active summary that a developer can follow at a glance:
 *
 *   ● claude  apply  [abc1]  ~/myapp
 *     ⟳  streaming  claude-sonnet-4-6
 *     →  Edit  src/app.component.ts
 *     ←  Edit  ok
 *     →  Bash  npm test
 *     ←  Bash  exit 0  │  "Tests passed (12 passing)"
 *     ≈  "He actualizado el componente para usar señales…" (92 chars)
 *   ○  done  [abc1]  in=1 240  out=452  $0.00021  5.8 s
 *
 * One instance per launch() call; not a singleton.
 */

import type { AgentEvent } from '../../../../shared/domain/agent-event';

// ── ANSI colour helpers ───────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  white:   '\x1b[37m',
};

function c(color: string, text: string): string {
  return `${color}${text}${C.reset}`;
}

/** Shorten an absolute path to ~/<relative> or the last 2 segments. */
function shortPath(p: string): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length).replace(/\\/g, '/')}`;
  return p.replace(/\\/g, '/').split('/').slice(-2).join('/');
}

/** Format a number with thousands separators. */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** Truncate a string to `maxLen` chars, appending `…` if cut. */
function trunc(s: string, maxLen: number): string {
  const clean = s.replace(/\n/g, '↵').replace(/\r/g, '');
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen) + '…';
}

/** Format milliseconds as "1.2 s" or "340 ms". */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Print with process.stdout.write (no extra newline buffering). */
function out(line: string): void {
  process.stdout.write(line + '\n');
}

// ── RunLogger ─────────────────────────────────────────────────────────────────

export class RunLogger {
  private readonly startMs: number;
  /** Short run id tag shown on every line. */
  private readonly tag: string;

  // Accumulated state
  private textBuf = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd: number | undefined;
  private currentModel: string | undefined;

  // Per-tool tracking: id → { name, input, startMs }
  private readonly activeTools = new Map<string, { name: string; input: string; startMs: number }>();

  constructor(
    private readonly agentId: string,
    runIdHint: string,
    private readonly project: string,
    private readonly mode: string,
  ) {
    this.startMs = Date.now();
    this.tag = `[${runIdHint.slice(0, 6)}]`;
    this.printHeader();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Feed a parsed AgentEvent from the stream. */
  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'status':         this.onStatus(event.label, event.model); break;
      case 'text_delta':     this.onTextDelta(event.delta); break;
      case 'thinking_start': this.onThinkingStart(); break;
      case 'thinking_delta': break; // not shown individually
      case 'tool_use':       this.onToolUse(event.id, event.name, event.input); break;
      case 'tool_result':    this.onToolResult(event.toolUseId, event.content, event.isError); break;
      case 'usage':          this.onUsage(event.inputTokens, event.outputTokens, event.costUsd); break;
      case 'error':          this.onAgentError(event.message); break;
      case 'turn_end':       break; // captured in finish()
      case 'session_started':break;
      case 'raw':            break; // skip raw lines
      default:               break;
    }
  }

  /** Call when the process exits cleanly (code 0 or natural SIGTERM). */
  onDone(): void {
    this.printTextPreview();
    this.printFooter('done', C.green);
  }

  /** Call when the run ends in error, cancellation, or crash. */
  onFail(reason: string): void {
    this.printTextPreview();
    this.printFooter(`fail  ${c(C.dim, trunc(reason, 60))}`, C.red);
  }

  // ── Private: event handlers ─────────────────────────────────────────────────

  private onStatus(label: string, model?: string): void {
    if (model && !this.currentModel) {
      this.currentModel = model;
      out(`  ${c(C.cyan, '⟳')}  ${c(C.dim, 'streaming')}  ${c(C.cyan, model)}`);
    }
  }

  private onThinkingStart(): void {
    out(`  ${c(C.magenta, '💭')}  ${c(C.dim, 'thinking…')}`);
  }

  private onTextDelta(delta: string): void {
    this.textBuf += delta;
  }

  private onToolUse(id: string, name: string, input: unknown): void {
    const inputStr = this.formatToolInput(name, input);
    this.activeTools.set(id, { name, input: inputStr, startMs: Date.now() });
    out(`  ${c(C.yellow, '→')}  ${c(C.bold + C.yellow, name)}  ${c(C.dim, inputStr)}`);
  }

  private onToolResult(toolUseId: string, content: string, isError: boolean): void {
    const tool = this.activeTools.get(toolUseId);
    const name = tool?.name ?? '?';
    const elapsed = tool ? fmtMs(Date.now() - tool.startMs) : '';
    this.activeTools.delete(toolUseId);

    const preview = trunc(content.trim().replace(/\s+/g, ' '), 80);
    const icon = isError ? c(C.red, '✗') : c(C.green, '←');
    const elapsedStr = elapsed ? `  ${c(C.dim, elapsed)}` : '';

    if (isError) {
      out(`  ${icon}  ${c(C.red, name)}${elapsedStr}  ${c(C.red, preview)}`);
    } else if (preview) {
      out(`  ${icon}  ${c(C.green, name)}${elapsedStr}  ${c(C.dim, `"${preview}"`)}`);
    } else {
      out(`  ${icon}  ${c(C.green, name)}${elapsedStr}  ${c(C.dim, 'ok')}`);
    }
  }

  private onUsage(inputTokens?: number, outputTokens?: number, costUsd?: number): void {
    if (inputTokens !== undefined) this.inputTokens = Math.max(this.inputTokens, inputTokens);
    if (outputTokens !== undefined) this.outputTokens = Math.max(this.outputTokens, outputTokens);
    if (costUsd !== undefined) this.costUsd = (this.costUsd ?? 0) + costUsd;
  }

  private onAgentError(message: string): void {
    out(`  ${c(C.red, '!')}  ${c(C.red, trunc(message, 100))}`);
  }

  // ── Private: formatting helpers ─────────────────────────────────────────────

  /** Extract the most useful piece of a tool input for one-line display. */
  private formatToolInput(toolName: string, input: unknown): string {
    if (!input || typeof input !== 'object') return '';
    const obj = input as Record<string, unknown>;

    // Common well-known fields by tool name
    if (toolName === 'Bash' || toolName === 'Shell') {
      const cmd = typeof obj['command'] === 'string' ? obj['command'] : null;
      return cmd ? trunc(cmd, 70) : '';
    }
    if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read' || toolName === 'MultiEdit') {
      const path = typeof obj['file_path'] === 'string' ? obj['file_path']
                 : typeof obj['path'] === 'string'      ? obj['path'] : null;
      return path ? shortPath(path) : '';
    }
    if (toolName === 'WebFetch' || toolName === 'WebSearch') {
      const q = typeof obj['url'] === 'string' ? obj['url']
              : typeof obj['query'] === 'string' ? obj['query'] : null;
      return q ? trunc(q, 70) : '';
    }

    // Fallback: first string value found
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.length > 0) return trunc(v, 70);
    }
    return '';
  }

  private printHeader(): void {
    const proj = c(C.cyan,   shortPath(this.project));
    const agent = c(C.bold + C.white, this.agentId);
    const mode  = c(C.dim,  this.mode);
    const tag   = c(C.dim,  this.tag);
    out(`${c(C.green, '●')}  ${agent}  ${mode}  ${tag}  ${proj}`);
  }

  private printTextPreview(): void {
    const text = this.textBuf.trim();
    if (!text) return;
    const preview = trunc(text, 120);
    out(`  ${c(C.blue, '≈')}  ${c(C.dim, '"')}${c(C.white, preview)}${c(C.dim, '"')}  ${c(C.dim, `(${fmt(text.length)} chars)`)}`);
  }

  private printFooter(status: string, color: string): void {
    const elapsed = fmtMs(Date.now() - this.startMs);
    const parts: string[] = [c(color, status), c(C.dim, this.tag)];

    if (this.inputTokens > 0 || this.outputTokens > 0) {
      parts.push(
        `${c(C.dim, 'in=')}${c(C.white, fmt(this.inputTokens))}` +
        ` ${c(C.dim, 'out=')}${c(C.white, fmt(this.outputTokens))}`,
      );
    }
    if (this.costUsd !== undefined && this.costUsd > 0) {
      parts.push(c(C.yellow, `$${this.costUsd.toFixed(5)}`));
    }
    parts.push(c(C.dim, elapsed));

    out(`${c(color, '○')}  ${parts.join('  ')}`);
  }
}
