// Captures audio from the mic, decodes via Web Audio, downsamples to
// 16kHz mono Float32 and hands the buffer to whoever called record().
// No ffmpeg dependency — Chromium decodes webm/opus natively.

export type VoiceState = 'idle' | 'recording' | 'transcribing';

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private resolveStop: ((pcm: Float32Array) => void) | null = null;
  private rejectStop:  ((err: unknown) => void) | null = null;

  /** Starts recording. Resolves with PCM (16kHz mono Float32) once stop() is called. */
  async start(): Promise<Float32Array> {
    if (this.recorder) throw new Error('already recording');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);

    this.recorder.addEventListener('dataavailable', (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });

    this.recorder.addEventListener('stop', () => {
      const release = this.stream;
      this.stream = null;
      release?.getTracks().forEach((t) => t.stop());

      this.processBlobs()
        .then((pcm) => this.resolveStop?.(pcm))
        .catch((err) => this.rejectStop?.(err));
    });

    this.recorder.start();

    return new Promise<Float32Array>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
  }

  stop() { this.recorder?.stop(); this.recorder = null; }

  private async processBlobs(): Promise<Float32Array> {
    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    ctx.close();
    return resampleToMono16k(decoded);
  }
}

async function resampleToMono16k(buffer: AudioBuffer): Promise<Float32Array> {
  const target = 16000;
  const length = Math.ceil(buffer.duration * target);
  const offline = new OfflineAudioContext(1, length, target);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}
