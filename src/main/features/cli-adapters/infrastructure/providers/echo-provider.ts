import type {
  AgentProvider,
  Capabilities,
  ChildProcessLike,
  DetectionResult,
  Invocation,
  ProviderEnvironment,
  ProviderRequest,
  ProviderSession,
} from '../../../../../shared/domain/agent-provider';
import type { NormalizedEvent } from '../../../../../shared/domain/normalized-event';
import { ProviderPrepareError } from '../../../../../shared/domain/agent-provider';

const PROTOCOL_VERSION = 1;
/** Maximum prompt size this provider accepts (kept small for tests). */
const MAX_PROMPT_BYTES = 1_000_000;

/**
 * Reference in-process "echo" provider used for unit tests and contract
 * validation. It does not spawn any external binary: `attach()` creates
 * an async generator that replays the prompt as a series of `text_delta`
 * events, then finishes cleanly.
 *
 * Every real provider must pass the shared contract test suite that
 * exercises these same behaviors.
 */
export class EchoProvider implements AgentProvider {
  readonly id = 'echo';
  readonly displayName = 'Echo (test)';
  readonly metadata = {
    docsUrl: 'https://github.com/devia-app/devia',
  };

  async detect(env: ProviderEnvironment): Promise<DetectionResult> {
    void env;
    return { available: true, authStatus: 'ok', version: '1.0.0' };
  }

  capabilities(detection: DetectionResult): Capabilities {
    void detection;
    return {
      streaming: true,
      thinkingTraces: false,
      interactiveTools: false,
      fileTools: false,
      imageInputs: false,
      resume: false,
      sandboxModel: 'none',
    };
  }

  async prepare(req: ProviderRequest): Promise<Invocation> {
    const bytes = Buffer.byteLength(req.prompt, 'utf8');
    if (bytes > MAX_PROMPT_BYTES) {
      throw new ProviderPrepareError(
        'PROMPT_TOO_LARGE',
        `Prompt is ${bytes} bytes; maximum allowed is ${MAX_PROMPT_BYTES}`,
        true,
      );
    }
    return {
      command: 'echo',
      args: [req.prompt],
      env: {},
      stdinMode: 'ignore',
    };
  }

  attach(_child: ChildProcessLike, req: ProviderRequest): ProviderSession {
    const controller = new AbortController();
    let cancelCalled = false;

    const events: AsyncIterable<NormalizedEvent> = (async function* () {
      yield { kind: 'stream_start', protocolVersion: PROTOCOL_VERSION };
      yield { kind: 'status', label: 'streaming' };

      const words = req.prompt.split(/\s+/).filter(Boolean);
      for (const word of words) {
        if (controller.signal.aborted) break;
        yield { kind: 'text_delta', text: word + ' ' };
      }

      yield { kind: 'turn_end', reason: 'end' };
      yield {
        kind: 'stream_end',
        reason: controller.signal.aborted ? 'aborted' : 'completed',
      };
    })();

    return {
      events,

      // EchoProvider does not advertise interactiveTools so submitToolResult
      // is intentionally absent (AC4: given interactiveTools: false).

      cancel: async (reason) => {
        void reason;
        if (cancelCalled) return; // idempotent (AC5)
        cancelCalled = true;
        controller.abort();
      },
    };
  }
}
