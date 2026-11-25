/** WebAudio capture (AudioWorklet with ScriptProcessor fallback) and gapless PCM/WAV playout with instant barge-in stop. */

export function fromBase64(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, "");
  if (!clean) return new Uint8Array(0);
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isEncodedAudio(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // RIFF (WAV), OggS (Opus/Vorbis), fLaC (FLAC), ID3 or MPEG sync (MP3)
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return true;
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return true;
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return true;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;
  // MP4 / M4A / AAC (ftyp)
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return true;
  return false;
}

export type CueKind = "wake" | "thinking" | "interrupt";

export class AudioPlayer {
  private ownContext: AudioContext | null = null;
  private sharedContext: () => AudioContext | null = () => null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private generation = 0;
  onIdle: () => void = () => {};

  setSharedContext(getter: () => AudioContext | null): void {
    this.sharedContext = getter;
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  private async context(): Promise<AudioContext> {
    const shared = this.sharedContext();
    if (shared && shared.state !== "closed") {
      if (shared.state === "suspended") await shared.resume().catch(() => undefined);
      return shared;
    }
    if (!this.ownContext || this.ownContext.state === "closed") {
      const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
      this.ownContext = new Ctx();
    }
    if (this.ownContext.state === "suspended") {
      await this.ownContext.resume().catch(() => undefined);
    }
    return this.ownContext;
  }

  async decodeBytes(bytes: Uint8Array, fallbackPcmRate = 24000): Promise<AudioBuffer | null> {
    if (bytes.length === 0) return null;
    const ctx = await this.context();
    if (isEncodedAudio(bytes)) {
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return await ctx.decodeAudioData(copy);
    }
    return this.pcm16ToBuffer(ctx, bytes, fallbackPcmRate);
  }

  async decodePcm16(bytes: Uint8Array, sampleRate: number): Promise<AudioBuffer | null> {
    if (bytes.length < 2) return null;
    const ctx = await this.context();
    return this.pcm16ToBuffer(ctx, bytes, sampleRate);
  }

  private pcm16ToBuffer(ctx: AudioContext, bytes: Uint8Array, sampleRate: number): AudioBuffer {
    const count = Math.floor(bytes.byteLength / 2);
    const buffer = ctx.createBuffer(1, Math.max(1, count), sampleRate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
    for (let i = 0; i < count; i += 1) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }
    return buffer;
  }

  async playBuffer(buffer: AudioBuffer, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const ctx = await this.context();
    if (generation !== this.generation) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.01, this.nextTime);
    this.nextTime = startAt + buffer.duration;
    this.sources.add(source);
    await new Promise<void>((resolve) => {
      source.onended = () => {
        this.sources.delete(source);
        try {
          source.disconnect();
        } catch {
          // ignore
        }
        if (this.sources.size === 0 && generation === this.generation) {
          this.nextTime = 0;
          this.onIdle();
        }
        resolve();
      };
      try {
        source.start(startAt);
      } catch {
        this.sources.delete(source);
        resolve();
      }
    });
  }

  /** Subtle synthesized audio cue so turn boundaries feel crisp without external audio assets. */
  cue(kind: CueKind): void {
    void this.context()
      .then((ctx) => {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        if (kind === "wake") {
          osc.frequency.setValueAtTime(520, now);
          osc.frequency.exponentialRampToValueAtTime(740, now + 0.06);
        } else if (kind === "interrupt") {
          osc.frequency.setValueAtTime(600, now);
          osc.frequency.exponentialRampToValueAtTime(420, now + 0.045);
        } else {
          osc.frequency.setValueAtTime(440, now);
          osc.frequency.exponentialRampToValueAtTime(520, now + 0.05);
        }
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.04, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.08);
      })
      .catch(() => undefined);
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** Immediately halts all playing and scheduled buffers (<5ms). */
  stop(): boolean {
    const wasPlaying = this.sources.size > 0;
    this.generation += 1;
    this.nextTime = 0;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      try {
        source.disconnect();
      } catch {
        // ignore
      }
    }
    this.sources.clear();
    return wasPlaying;
  }

  close(): void {
    this.stop();
    if (this.ownContext) {
      void this.ownContext.close().catch(() => undefined);
      this.ownContext = null;
    }
  }
}

const WORKLET_CODE = `
class BuzzVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(512);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.frame[this.offset++] = input[i];
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame);
          this.frame = new Float32Array(512);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("buzz-voice-capture", BuzzVoiceCapture);
`;

export interface CaptureHandle {
  disconnect(): void;
}

/** Captures mono float PCM off the main thread via AudioWorklet, falling back to ScriptProcessorNode if blocked. */
export async function attachCapture(
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  onSamples: (samples: Float32Array) => void,
): Promise<CaptureHandle> {
  if (typeof AudioWorkletNode !== "undefined" && context.audioWorklet?.addModule) {
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "application/javascript" }));
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      url = null;
      const worklet = new AudioWorkletNode(context, "buzz-voice-capture");
      // Keep node active without routing mic audio to speakers (0-gain sink).
      const sink = context.createGain();
      sink.gain.value = 0;
      worklet.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (data && data.length) onSamples(data);
      };
      source.connect(worklet);
      worklet.connect(sink);
      sink.connect(context.destination);
      return {
        disconnect() {
          worklet.port.onmessage = null;
          try {
            worklet.port.close();
          } catch {
            // ignore
          }
          try {
            source.disconnect(worklet);
            worklet.disconnect();
            sink.disconnect();
          } catch {
            // ignore
          }
        },
      };
    } catch {
      if (url) URL.revokeObjectURL(url);
    }
  }

  const node = context.createScriptProcessor(1024, 1, 1);
  const sink = context.createGain();
  sink.gain.value = 0;
  node.onaudioprocess = (event) => {
    onSamples(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(node);
  node.connect(sink);
  sink.connect(context.destination);
  return {
    disconnect() {
      node.onaudioprocess = null;
      try {
        source.disconnect(node);
        node.disconnect();
        sink.disconnect();
      } catch {
        // ignore
      }
    },
  };
}
