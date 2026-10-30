import type { Feature, FeatureContext } from '../../shared/feature';
import { IPC } from '../../../shared/contracts/ipc-channels';

/**
 * Whisper transcription. The renderer captures audio via MediaRecorder +
 * Web Audio API and sends pre-decoded 16kHz mono Float32 PCM as an
 * ArrayBuffer; only the Whisper pipeline lives in the main process.
 *
 * `@xenova/transformers` is ESM-only and ships a ~150 MB model, so the
 * import is dynamic and the load is fired from `onReady` (deferred 1.5 s
 * after first paint by the shell).
 */
type Transcriber = (
  input: Float32Array,
) => Promise<{ text?: string } | { text?: string }[]>;

export function buildVoiceFeature(): Feature {
  let transcriberPromise: Promise<Transcriber> | null = null;

  const loadTranscriber = (): Promise<Transcriber> => {
    if (transcriberPromise) return transcriberPromise;
    transcriberPromise = (async () => {
      // `@xenova/transformers` is ESM-only and its `pipeline` generic narrows
      // the result by task. We pin the runtime type to our local `Transcriber`
      // shape; the cast is the seam between the package's typed generics and
      // the simple `Float32Array → { text }` contract we actually call.
      type LooseModule = {
        pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
      };
      const mod = (await import('@xenova/transformers')) as unknown as LooseModule;
      const pipe = await mod.pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
        language: 'es',
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      return pipe as Transcriber;
    })();
    return transcriberPromise;
  };

  return {
    id: 'voice',
    register(ctx: FeatureContext) {
      ctx.ipc.handle(IPC.voiceTranscribe, async (_e, arrayBuffer: ArrayBuffer) => {
        try {
          const pcm = new Float32Array(arrayBuffer);
          const t = await loadTranscriber();
          const result = await t(pcm);
          const first = Array.isArray(result) ? result[0] : result;
          return { text: (first?.text ?? '').trim() };
        } catch (err: unknown) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      });
    },
    onReady() {
      loadTranscriber()
        .then(() => console.log('[voice] Whisper model ready'))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[voice] warm-up failed:', message);
        });
    },
  };
}
