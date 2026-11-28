import type { RunId } from '../../shared/domain/agent';
import type { RunGateway } from './run-gateway';
import type { RunCompletion, RunOutcome } from './ports/run-completion.port';
import { foldAssistantText } from './stream-text';

/**
 * {@link RunCompletion} over the run gateway. One subscription per `await`,
 * released on every exit (done, failed, cancelled, timeout): a long run can
 * accumulate megabytes of text, and a leaked listener would keep it alive.
 *
 * The first `start` of the run key fixes the `runId`; any later event with a
 * different `runId` (a queued follow-up, another pane's run) is dropped.
 */
export function createRunCompletion(gateway: RunGateway): RunCompletion {
  return {
    await(runKey, opts) {
      return new Promise<RunOutcome>((resolve) => {
        let runId: RunId | undefined;
        let text = '';
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (outcome: RunOutcome): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          unsubscribe();
          resolve(outcome);
        };

        const unsubscribe = gateway.subscribe((event) => {
          if (event.project !== runKey || event.type === 'worker') return;
          if (event.type === 'start') {
            if (runId === undefined) runId = event.runId;
            return;
          }
          if (runId !== undefined && event.runId !== undefined && event.runId !== runId) return;
          if (event.type === 'output') {
            if (runId !== undefined) text = foldAssistantText(event.line, text);
            return;
          }
          if (event.type !== 'end') return;
          if (event.cancelReason !== undefined) {
            finish({ status: 'cancelled', finalText: text });
          } else if (event.code === 0 && event.error === undefined) {
            finish({ status: 'done', finalText: text });
          } else {
            const error = event.error ?? (event.code !== null ? `exit code ${event.code}` : undefined);
            finish({ status: 'failed', finalText: text, ...(error !== undefined && { error }) });
          }
        });

        if (opts?.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            opts.onTimeout?.();
            finish({ status: 'timeout', finalText: text });
          }, opts.timeoutMs);
        }
      });
    },
  };
}
