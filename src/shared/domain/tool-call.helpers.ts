import { isAskUserTool, normalizeAskUserQuestionInput } from './question-ask';

/**
 * Pure display-formatting helpers extracted from `ToolCallCardComponent` so
 * they can be unit-tested in the Vitest (Node / src/main) suite without
 * requiring Angular TestBed.
 *
 * The component delegates its `formattedInput`, `truncatedResult`, and
 * `isRunningState` computed signals to these functions.
 */

/**
 * Maximum number of characters to show in the result pane before truncating.
 * Matches the constant used in ToolCallCardComponent.
 */
export const RESULT_TRUNCATE_LIMIT = 2000;

/** Truncation suffix appended to clipped result text. */
const TRUNCATE_SUFFIX = '\n…[truncated]';

export interface ConsoleTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

interface ShellToken {
  readonly value: string;
  readonly quote: '"' | "'" | null;
  readonly start: number;
  readonly end: number;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function basenameOfCommand(value: string): string {
  const clean = value.replace(/\\/g, '/');
  const slash = clean.lastIndexOf('/');
  return (slash >= 0 ? clean.slice(slash + 1) : clean).toLowerCase();
}

function tokenizeShellCommand(value: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const text = value.trim();
  let i = 0;

  while (i < text.length) {
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
    if (i >= text.length) break;

    const start = i;
    const first = text[i];
    if (first === '"' || first === "'") {
      const quote = first;
      i++;
      let body = '';
      while (i < text.length) {
        const ch = text.charAt(i);
        if (ch === quote) {
          i++;
          break;
        }
        if (
          quote === '"' &&
          ch === '\\' &&
          i + 1 < text.length &&
          (text[i + 1] === '"' || text[i + 1] === '\\')
        ) {
          body += text.charAt(i + 1);
          i += 2;
          continue;
        }
        body += ch;
        i++;
      }
      tokens.push({ value: body, quote, start, end: i });
      continue;
    }

    let body = '';
    while (i < text.length && !/\s/.test(text.charAt(i))) {
      body += text.charAt(i);
      i++;
    }
    tokens.push({ value: body, quote: null, start, end: i });
  }

  return tokens;
}

function restAfterToken(command: string, token: ShellToken): string {
  return command.trim().slice(token.end).trim();
}

function stripOneQuotedLayer(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === last && (first === '"' || first === "'"))
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function commandArgAfter(tokens: readonly ShellToken[], command: string, optionIndex: number): string | null {
  const next = tokens[optionIndex + 1];
  if (next?.quote) return next.value.trim();
  const option = tokens[optionIndex];
  if (!option) return null;
  const rest = restAfterToken(command, option);
  return rest ? stripOneQuotedLayer(rest) : null;
}

function findPowershellCommand(tokens: readonly ShellToken[]): number {
  return tokens.findIndex((token, index) =>
    index > 0 && ['-command', '-c', '/command', '/c'].includes(token.value.toLowerCase()),
  );
}

function findCmdCommand(tokens: readonly ShellToken[]): number {
  return tokens.findIndex((token, index) =>
    index > 0 && ['/c', '-c'].includes(token.value.toLowerCase()),
  );
}

function findPosixShellCommand(tokens: readonly ShellToken[]): number {
  return tokens.findIndex((token, index) => {
    if (index === 0) return false;
    const value = token.value.toLowerCase();
    return value === '-c' || /^-[a-z]*c[a-z]*$/.test(value);
  });
}

/**
 * Return a UI-friendly command by stripping common shell wrappers that agents
 * emit on Windows/POSIX. This is presentation-only: callers should keep the
 * original command for logs, execution, and diagnostic copy paths.
 */
export function formatTerminalCommandForDisplay(command: string): string {
  const original = command.trim();
  if (!original) return original;

  const tokens = tokenizeShellCommand(original);
  const first = tokens[0];
  if (!first) return original;

  const bin = basenameOfCommand(first.value);
  if (bin === 'powershell.exe' || bin === 'powershell' || bin === 'pwsh.exe' || bin === 'pwsh') {
    const optionIndex = findPowershellCommand(tokens);
    return optionIndex >= 0 ? commandArgAfter(tokens, original, optionIndex) ?? original : original;
  }

  if (bin === 'cmd.exe' || bin === 'cmd') {
    const optionIndex = findCmdCommand(tokens);
    return optionIndex >= 0 ? commandArgAfter(tokens, original, optionIndex) ?? original : original;
  }

  if (['bash', 'bash.exe', 'sh', 'sh.exe', 'zsh', 'zsh.exe', 'fish', 'fish.exe'].includes(bin)) {
    const optionIndex = findPosixShellCommand(tokens);
    return optionIndex >= 0 ? commandArgAfter(tokens, original, optionIndex) ?? original : original;
  }

  return original;
}

/**
 * Format the tool input for display.
 *
 * - Bash / Execute: extracts `command` field; falls back to JSON.
 * - Edit / Write / MultiEdit / Read: extracts `file_path` or `path`; falls back to JSON.
 * - AskUserQuestion: extracts `question` or `questions[0].question`; falls back to JSON.
 * - All other tools: serializes the whole input object as pretty JSON.
 *
 * Returns `null` when `input` is `null` / `undefined`.
 */
export function formatToolInput(name: string, input: unknown): string | null {
  if (input == null) return null;

  if (name === 'Bash' || name === 'Execute') {
    const inp = input as { command?: string };
    return typeof inp.command === 'string'
      ? formatTerminalCommandForDisplay(inp.command)
      : safeStringify(input);
  }

  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'Read') {
    const inp = input as { file_path?: string; path?: string };
    return inp.file_path ?? inp.path ?? safeStringify(input);
  }

  if (isAskUserTool(name)) {
    return normalizeAskUserQuestionInput(input).question;
  }

  return safeStringify(input);
}

/**
 * Truncate a result string to `limit` characters (default: `RESULT_TRUNCATE_LIMIT`).
 *
 * Returns:
 *   - `null` when `result` is `undefined` / `null` / empty string (no output section).
 *   - The original string when it is within the limit.
 *   - A clipped string with `…[truncated]` suffix when it exceeds the limit.
 */
export function truncateResult(
  result: string | undefined,
  limit: number = RESULT_TRUNCATE_LIMIT,
): string | null {
  if (!result) return null;
  return result.length > limit ? result.slice(0, limit) + TRUNCATE_SUFFIX : result;
}

function dashedColumnSpans(separatorLine: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = /-{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(separatorLine)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function sliceConsoleRow(line: string, starts: readonly number[]): string[] {
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? line.length;
    return line.slice(start, end).trim();
  });
}

/**
 * Parse fixed-width command output tables such as PowerShell's default
 * formatter. Returns null for anything ambiguous so callers can keep the raw
 * `<pre>` fallback.
 */
export function parseConsoleTableOutput(output: string): ConsoleTable | null {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();

  if (lines.length < 3) return null;

  const separatorIndex = lines.findIndex((line, index) =>
    index > 0 && /^(\s*-{2,}\s*){2,}$/.test(line),
  );
  if (separatorIndex < 1) return null;

  const headerLine = lines[separatorIndex - 1];
  const separatorLine = lines[separatorIndex];
  if (headerLine === undefined || separatorLine === undefined) return null;
  const spans = dashedColumnSpans(separatorLine);
  if (spans.length < 2) return null;

  const starts = spans.map((span) => span.start);
  const headers = sliceConsoleRow(headerLine, starts);
  if (headers.some((header) => header.length === 0)) return null;

  const bodyLines = lines.slice(separatorIndex + 1).filter((line) => line.trim() !== '');
  if (bodyLines.length === 0) return null;

  const rows = bodyLines.map((line) => sliceConsoleRow(line, starts));
  return { headers, rows };
}

/**
 * Returns `true` when the tool call is still running (no result yet, and no
 * explicit error flag).
 *
 * A running state means the spinner should be shown in the card header.
 */
export function isRunningState(
  result: string | undefined,
  isError: boolean | undefined,
): boolean {
  return !result && !isError;
}
