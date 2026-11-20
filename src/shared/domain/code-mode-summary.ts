import type { ToolCallRecord } from './chat';
import { CODE_MODE_DENIED_PREFIX } from './code-mode';

/**
 * What the chat card of a `run_script` call shows (S-50). Pure: it reads the tool
 * call the agent made, the text `devia-code-mode` returned for it, and the nested
 * calls the relay attached, so it can be tested without Angular.
 *
 * The text formats it reads are the gateway's own (`code-mode-tools.ts`): a JSON
 * `{ value, logs?, stats, warnings? }` on success, and for failures one of
 * "The script does not type-check. No tool was called. ...", "Script failed [kind]
 * (line N): message ...", or a plain message.
 */

/** `mcp__devia-code-mode__run_script`, `mcp__devia_code_mode__run_script`, `devia-code-mode.run_script`, `run_script`. */
const RUN_SCRIPT_NAME = /(?:code[-_]mode.*run_script|^run_script)$/;

export function isRunScriptTool(name: string): boolean {
  return RUN_SCRIPT_NAME.test(name);
}

export type ScriptStatus = 'running' | 'ok' | 'type_error' | 'runtime_error' | 'denied' | 'error';

export interface ScriptCallView {
  id: string;
  /** `server.tool` */
  label: string;
  argsText: string;
  state: 'running' | 'ok' | 'denied' | 'error';
  /** Size of the response, the reason it was denied, or the failure message. */
  detail: string;
}

export interface ScriptSummary {
  status: ScriptStatus;
  description: string | null;
  code: string | null;
  servers: string[];
  calls: ScriptCallView[];
  callCount: number;
  deniedCount: number;
  durationMs: number | null;
  /** Rough tokens of tool data that never reached the agent; null when unknown. */
  tokensSavedEstimate: number | null;
  /** The returned value on one line, or the first line of the error. */
  preview: string | null;
  /** The returned value, pretty-printed and capped. */
  valueText: string | null;
  failureKind: string | null;
  line: number | null;
  logs: string[];
  warnings: string | null;
}

const BYTES_PER_TOKEN = 4;
const PREVIEW_CHARS = 300;
const VALUE_CHARS = 4000;
const ARGS_CHARS = 80;

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function callView(call: ToolCallRecord): ScriptCallView {
  const label = call.name;
  const argsText = call.input === undefined ? '' : oneLine(JSON.stringify(call.input) ?? '', ARGS_CHARS);
  const result = call.result;
  if (result === undefined) return { id: call.id, label, argsText, state: 'running', detail: '' };
  if (result.startsWith(CODE_MODE_DENIED_PREFIX)) {
    return { id: call.id, label, argsText, state: 'denied', detail: result.slice(CODE_MODE_DENIED_PREFIX.length) };
  }
  return { id: call.id, label, argsText, state: call.isError ? 'error' : 'ok', detail: result };
}

const EMPTY: Omit<ScriptSummary, 'status' | 'description' | 'code' | 'servers' | 'calls' | 'callCount'> = {
  deniedCount: 0,
  durationMs: null,
  tokensSavedEstimate: null,
  preview: null,
  valueText: null,
  failureKind: null,
  line: null,
  logs: [],
  warnings: null,
};

export function summarizeScript(call: ToolCallRecord, children: readonly ToolCallRecord[]): ScriptSummary {
  const input = isRecord(call.input) ? call.input : {};
  const calls = children.map(callView);
  const base = {
    description: typeof input['description'] === 'string' ? input['description'] : null,
    code: typeof input['code'] === 'string' ? input['code'] : null,
    servers: [...new Set(calls.map((c) => c.label.split('.')[0] ?? c.label))],
    calls,
    callCount: calls.length,
    ...EMPTY,
  };
  const text = call.result;
  if (text === undefined) return { ...base, status: 'running' };

  if (call.isError) return { ...base, ...failure(text), callCount: text.startsWith('The script does not type-check') ? 0 : calls.length };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...base, status: 'ok', preview: oneLine(text, PREVIEW_CHARS), valueText: text.slice(0, VALUE_CHARS) };
  }
  if (!isRecord(parsed) || !('value' in parsed)) {
    return { ...base, status: 'ok', preview: oneLine(text, PREVIEW_CHARS), valueText: text.slice(0, VALUE_CHARS) };
  }
  const stats = isRecord(parsed['stats']) ? parsed['stats'] : {};
  const fetched = num(stats['bytesFetched']);
  const returned = num(stats['bytesReturned']);
  const pretty = JSON.stringify(parsed['value'], null, 2) ?? 'null';
  return {
    ...base,
    status: 'ok',
    callCount: num(stats['calls']) ?? calls.length,
    deniedCount: num(stats['denied']) ?? 0,
    durationMs: num(stats['durationMs']),
    tokensSavedEstimate:
      fetched !== null && returned !== null ? Math.max(0, Math.round((fetched - returned) / BYTES_PER_TOKEN)) : null,
    preview: oneLine(JSON.stringify(parsed['value']) ?? 'null', PREVIEW_CHARS),
    valueText: pretty.length > VALUE_CHARS ? `${pretty.slice(0, VALUE_CHARS)}…` : pretty,
    logs: Array.isArray(parsed['logs']) ? parsed['logs'].filter((l): l is string => typeof l === 'string') : [],
    warnings: typeof parsed['warnings'] === 'string' ? parsed['warnings'] : null,
  };
}

function failure(text: string): Pick<ScriptSummary, 'status' | 'preview' | 'failureKind' | 'line' | 'valueText' | 'durationMs' | 'deniedCount'> {
  const common = { valueText: null, durationMs: null, deniedCount: 0 };
  if (text.startsWith('The script does not type-check')) {
    const [, ...diagnostics] = text.split('\n');
    return { ...common, status: 'type_error', preview: oneLine(diagnostics.join(' '), PREVIEW_CHARS), failureKind: null, line: null };
  }
  const m = /^Script failed \[([a-z_]+)\](?: \(line (\d+)\))?: ([\s\S]*?)(?:\nconsole\.log output:|\nstats: |$)/.exec(text);
  if (m) {
    const message = m[3] ?? '';
    return {
      ...common,
      status: message.includes('ToolDeniedError') ? 'denied' : 'runtime_error',
      preview: oneLine(message, PREVIEW_CHARS),
      failureKind: m[1] ?? null,
      line: m[2] !== undefined ? Number(m[2]) : null,
    };
  }
  return { ...common, status: 'error', preview: oneLine(text, PREVIEW_CHARS), failureKind: null, line: null };
}
