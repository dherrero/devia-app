import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { UiToolName } from '../../shared/domain/ui-tools';

/**
 * File-based rendezvous between the `devia-ui` MCP server and the main process
 * (S-25, generalises the S-24 `ask-rendezvous`).
 *
 * Three processes speak this protocol and none of them can call each other:
 *   - the MCP server (spawned by the agent CLI) writes `<callId>.request.json`
 *     and, for a blocking tool, polls for `<callId>.answer.json`;
 *   - the main process polls the directory, surfaces each request to the
 *     renderer, and writes the answer file back when the user resolves it.
 *
 * The directory is per RUN (it embeds the runId), so concurrent split-view runs
 * never share one — unlike `devia-memory` / `devia-kanban`, which are keyed per
 * PROJECT.
 *
 * The `tool` discriminator is what turns the single-purpose S-24 protocol into
 * a multiplexed one: the main process reads it to decide which handler and
 * which timeout policy apply.
 */

export const POLL_INTERVAL_MS = 100;
export const DEFAULT_UI_TIMEOUT_MS = 5 * 60 * 1_000;

/** Root under `os.tmpdir()`. Exported so the startup sweep can find stale runs. */
export const UI_RENDEZVOUS_ROOT = 'devia-ui';

const REQUEST_SUFFIX = '.request.json';
const ANSWER_SUFFIX = '.answer.json';

export interface UiRequest {
  callId: string;
  tool: UiToolName;
  toolInput: unknown;
  /** False for fire-and-forget tools: nobody will ever write an answer file. */
  expectsAnswer: boolean;
  ts?: number;
}

export interface UiAnswer {
  answer: string;
}

/** Keep a caller-supplied id from escaping the rendezvous directory. */
export function safeCallFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function uiRunDir(runId: string): string {
  return path.join(os.tmpdir(), UI_RENDEZVOUS_ROOT, safeCallFileName(runId));
}

export function uiRendezvousRootDir(): string {
  return path.join(os.tmpdir(), UI_RENDEZVOUS_ROOT);
}

export function requestFilePath(dir: string, callId: string): string {
  return path.join(dir, `${safeCallFileName(callId)}${REQUEST_SUFFIX}`);
}

export function answerFilePath(dir: string, callId: string): string {
  return path.join(dir, `${safeCallFileName(callId)}${ANSWER_SUFFIX}`);
}

export function isRequestFileName(name: string): boolean {
  return name.endsWith(REQUEST_SUFFIX);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export interface WriteUiRequestInput {
  callId: string;
  tool: UiToolName;
  toolInput: unknown;
  expectsAnswer?: boolean;
}

export function writeUiRequest(dir: string, request: WriteUiRequestInput): void {
  fs.mkdirSync(dir, { recursive: true });
  // `toolUseId` is written alongside `callId` so a reader from the S-24
  // implementation still resolves the id.
  writeJsonAtomic(requestFilePath(dir, request.callId), {
    callId: request.callId,
    toolUseId: request.callId,
    tool: request.tool,
    toolInput: request.toolInput,
    expectsAnswer: request.expectsAnswer !== false,
    ts: Date.now(),
  });
}

/**
 * Fire-and-forget variant. Semantically distinct from {@link writeUiRequest}
 * even though it shares the file shape: the caller returns immediately and the
 * main process is responsible for sweeping the file once it has consumed it.
 */
export function writeUiSignal(
  dir: string,
  callId: string,
  tool: UiToolName,
  toolInput: unknown,
): void {
  writeUiRequest(dir, { callId, tool, toolInput, expectsAnswer: false });
}

export function readUiRequest(file: string): UiRequest | null {
  const record = readJsonObject(file);
  if (!record) return null;
  const callId = firstString(record, ['callId', 'toolUseId']);
  if (callId === null) return null;

  // A request written by an S-24 build carries no `tool`: it can only ever have
  // been a question, so an in-flight run started before the upgrade still
  // resolves instead of being silently dropped.
  const tool = typeof record['tool'] === 'string' ? (record['tool'] as UiToolName) : 'ask_user';
  const ts = typeof record['ts'] === 'number' ? record['ts'] : undefined;
  return {
    callId,
    tool,
    toolInput: record['toolInput'],
    expectsAnswer: record['expectsAnswer'] !== false,
    ...(ts !== undefined && { ts }),
  };
}

export function writeUiAnswer(dir: string, callId: string, answer: string): void {
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(answerFilePath(dir, callId), { answer });
}

/**
 * Answer payload written while the PreToolUse hook was the asking side: Claude
 * expected the whole tool input back, with the answers folded in. Kept until
 * the hook is retired so an in-flight run started by an older build still
 * resolves.
 */
export function writeLegacyUiAnswer(dir: string, callId: string, updatedInput: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(answerFilePath(dir, callId), { updatedInput });
}

export function readUiAnswer(file: string): UiAnswer | null {
  const record = readJsonObject(file);
  if (!record) return null;

  const answer = record['answer'];
  if (typeof answer === 'string') return { answer };

  const legacy = legacyAnswerText(record['updatedInput']);
  return legacy === null ? null : { answer: legacy };
}

/** Raw payload of an answer file, for callers that need the legacy shape verbatim. */
export function readUiAnswerPayload(file: string): Record<string, unknown> | null {
  return readJsonObject(file);
}

/** Best-effort removal of both files of one call. */
export function removeUiCall(dir: string, callId: string): void {
  for (const file of [requestFilePath(dir, callId), answerFilePath(dir, callId)]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

function legacyAnswerText(updatedInput: unknown): string | null {
  if (!isRecord(updatedInput)) return null;
  const answers = updatedInput['answers'];
  if (!isRecord(answers)) return null;
  const texts = Object.values(answers).filter((v): v is string => typeof v === 'string');
  return texts.length > 0 ? texts.join('\n') : null;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
