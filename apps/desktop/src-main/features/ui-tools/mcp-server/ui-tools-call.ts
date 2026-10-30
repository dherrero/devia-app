import {
  POLL_INTERVAL_MS,
  answerFilePath,
  readUiAnswer,
  removeUiCall,
  writeUiRequest,
} from '../../../shared/ui-rendezvous';
import { uiToolFromPublicName, type UiToolName } from '../../../../shared/domain/ui-tools';
import { UI_TOOL_REGISTRY } from './tool-registry';

/**
 * The one behaviour every `devia-ui` tool shares: meet the main process on
 * disk. Blocking tools wait for the answer file; fire-and-forget tools return
 * as soon as the request is written.
 */

export interface UiToolResult {
  text: string;
  isError?: boolean;
}

/**
 * A local resolver that validated the call but still needs the main process
 * (`send_file`): the rendezvous goes ahead with `passThrough` as the request's
 * toolInput, and `ack` (when given) replaces the generic fire-and-forget ack.
 */
export interface UiPassThrough {
  passThrough: unknown;
  ack?: string;
}

export type UiLocalResolution = UiToolResult | UiPassThrough | null;

export interface UiToolDeps {
  uiDir: string;
  timeoutMs: number;
  advertised: readonly UiToolName[];
  newCallId: () => string;
  pollIntervalMs?: number;
  /**
   * Escape hatch for tools that resolve WITHOUT the user (`skill`, which only
   * reads files) or validate BEFORE the rendezvous (`send_file`, which is
   * fire-and-forget: a refusal noticed later would never reach the agent).
   * Returning null falls through to the rendezvous unchanged.
   */
  resolveLocally?: (tool: UiToolName, args: unknown) => Promise<UiLocalResolution>;
}

/**
 * Delivered as the tool result when nobody answers in time. Phrased as an
 * instruction because the agent reads it as the outcome of its own call: the
 * run may still be alive (the runner's own timeout is what kills it), so the
 * agent must be able to carry on without the answer.
 */
export const UI_TIMEOUT_RESULT = (publicName: string): string =>
  `No answer was received from the user before the timeout. ` +
  `Do not call ${publicName} again for this decision. ` +
  `Either proceed with the most reasonable default and state the assumption you made, ` +
  `or re-ask as plain text in your reply and end your turn.`;

const ACK = 'Recorded.';

export class UiToolError extends Error {}

export async function callUiTool(
  deps: UiToolDeps,
  publicName: string,
  args: unknown,
): Promise<UiToolResult> {
  const tool = uiToolFromPublicName(publicName);
  if (tool === null) throw new UiToolError(`Unknown tool: ${publicName}`);

  // Dispatch knows every tool, but a run only gets the subset the runner chose.
  // Refusing here (rather than crashing) keeps a hallucinated call cheap.
  if (!deps.advertised.includes(tool)) {
    return {
      text:
        `${publicName} is not available in this run. ` +
        `Continue without it — ask in plain text if you need a decision from the user.`,
      isError: true,
    };
  }

  const local = await deps.resolveLocally?.(tool, args);
  let toolInput = args ?? {};
  let ack = ACK;
  if (local && 'passThrough' in local) {
    toolInput = local.passThrough ?? {};
    if (local.ack !== undefined) ack = local.ack;
  } else if (local) {
    return local;
  }

  const def = UI_TOOL_REGISTRY[tool];
  const callId = deps.newCallId();
  const blocking = def.kind === 'blocking';

  writeUiRequest(deps.uiDir, {
    callId,
    tool,
    toolInput,
    expectsAnswer: blocking,
  });

  if (!blocking) return { text: ack };

  const answerFile = answerFilePath(deps.uiDir, callId);
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  try {
    const deadline = Date.now() + deps.timeoutMs;
    // The caller awaits this, but the server's readline loop does not — a
    // pending tool must never stop the server from serving other messages.
    while (Date.now() < deadline) {
      const answer = readUiAnswer(answerFile);
      if (answer !== null) return { text: answer.answer };
      await sleep(pollIntervalMs);
    }
    return { text: UI_TIMEOUT_RESULT(publicName), isError: true };
  } finally {
    removeUiCall(deps.uiDir, callId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
