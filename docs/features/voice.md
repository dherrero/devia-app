# Voice dictation

Status: partial
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Local speech-to-text for the composer using Whisper through `@xenova/transformers`.

## Does

- The renderer captures audio (MediaRecorder + Web Audio, `src/renderer/app/features/chat/chat-panel/services/voice-recorder.ts`) and sends 16 kHz mono Float32 PCM; `voice:transcribe` runs the pipeline in main (`src/main/features/voice/index.ts:buildVoiceFeature`).
- The model is `Xenova/whisper-base`, loaded lazily (dynamic import; fired from `onReady`, deferred 1.5 s after first paint), `chunk_length_s` 30, `stride_length_s` 5, language fixed to `es`.
- No API or network is used for transcription once the model files are cached.

## Does NOT

- Does NOT choose the language from the UI language: `language: 'es'` is hard-coded in the pipeline options.
- Does NOT ship the dependency in the packaged app's `dependencies`: `@xenova/transformers` is a devDependency in `package.json`, and electron-builder packages only `dependencies`. UNVERIFIED: whether the packaged app still resolves the module (run `npm run pack:dir` and test dictation before relying on it).
- Does NOT stream partial results; it transcribes a finished recording.

## Entry points

- `src/main/features/voice/index.ts:buildVoiceFeature` — IPC handler and Whisper loader
- `src/renderer/app/features/chat/chat-panel/services/voice-recorder.ts` — capture

## IPC / MCP surface

- `voice:transcribe`.

## Persistence

Model files cached by `@xenova/transformers` (location is the library default).

## Config

None.

## Gotchas

- The model is ~150 MB per the source comment; first use downloads it. UNVERIFIED offline behaviour on a fresh install.

## Tests

None found next to the feature.

## Related

[chat-ui.md](chat-ui.md), [memory.md](memory.md) (the same package is used for optional semantic re-ranking)
