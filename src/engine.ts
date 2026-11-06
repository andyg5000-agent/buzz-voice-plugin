export interface HostProcess {
  write(data: string): Promise<void>;
  end(data?: string): Promise<void>;
  kill(): Promise<void>;
  exited: Promise<number | null>;
}

export interface Host {
  spawn?: (
    id: string,
    options?: { args?: string[]; onStdout?: (data: string) => void; onStderr?: (data: string) => void },
  ) => Promise<HostProcess>;
}

export interface Settings {
  modelDir: string;
  whisper: string;
  llmUrl: string;
  llmModel: string;
  llmKey: string;
  voice: string;
  speak: boolean;
  microphone: string;
}

export const DEFAULT_SETTINGS: Settings = {
  modelDir: "~/buzz-voice-models",
  whisper: "small.en",
  llmUrl: "",
  llmModel: "",
  llmKey: "",
  voice: "",
  speak: true,
  microphone: "",
};

const SETTINGS_KEY = "buzz-voice-plugin.settings";

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(storage()?.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const value = storage()?.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  storage()?.setItem(key, JSON.stringify(value));
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function run(
  host: Host,
  id: string,
  args: string[],
  input?: string,
  onLine?: (line: string) => void,
): Promise<Run> {
  if (!host.spawn) throw new Error("This Buzz build cannot start local processes.");
  let stdout = "";
  let stderr = "";
  let partial = "";
  const process = await host.spawn(id, {
    args,
    onStdout: (data) => {
      stdout += data;
      if (!onLine) return;
      partial += data;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    onStderr: (data) => {
      stderr = (stderr + data).slice(-4000);
    },
  });
  await process.end(input ?? "");
  const code = await process.exited;
  return { code, stdout, stderr };
}

export interface EngineStatus {
  engine: boolean;
  model: boolean;
  buzzVoice: Record<string, unknown> | null;
}

function parseStatus(stdout: string): EngineStatus {
  const at = stdout.indexOf('{"engine"');
  if (at < 0) throw new Error("The setup script returned nothing.");
  const parsed = JSON.parse(stdout.slice(at).trim());
  return { engine: !!parsed.engine, model: !!parsed.model, buzzVoice: parsed.buzzVoice ?? null };
}

export async function checkEngine(host: Host, settings: Settings): Promise<EngineStatus> {
  const result = await run(host, "setup", [settings.modelDir, "check", settings.whisper]);
  return parseStatus(result.stdout);
}

export async function installEngine(
  host: Host,
  settings: Settings,
  progress: (step: string) => void,
): Promise<EngineStatus> {
  const result = await run(host, "setup", [settings.modelDir, "install", settings.whisper], "", (line) => {
    if (line.startsWith("progress ")) progress(line.slice(9));
  });
  if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").pop() || "Install failed.");
  return parseStatus(result.stdout);
}

export async function transcribe(host: Host, settings: Settings, wavBase64: string): Promise<string> {
  const result = await run(host, "stt", [settings.modelDir, settings.whisper], wavBase64);
  const line = result.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) {
    const why = result.stderr.trim().split("\n").pop();
    throw new Error(`Speech recognition failed${why ? `: ${why}` : "."}`);
  }
  const parsed = JSON.parse(line);
  if (parsed.error === "no-engine") throw new Error("The speech engine is not installed. Open Settings to install it.");
  if (parsed.error === "no-model") throw new Error("The whisper model is missing. Open Settings to install it.");
  return String(parsed.text ?? "").trim();
}

export function llmPoster(host: Host, settings: Settings) {
  return async (body: unknown): Promise<string> => {
    const base = settings.llmUrl.replace(/\/+$/, "");
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    const args = settings.llmKey ? ["-H", `Authorization: Bearer ${settings.llmKey}`, url] : [url];
    const result = await run(host, "llm", args, JSON.stringify(body));
    if (result.code !== 0) throw new Error(result.stderr.trim() || `The LLM call failed (${result.code}).`);
    return result.stdout;
  };
}

export class Speaker {
  private current: HostProcess | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: Host,
    private readonly settings: () => Settings,
  ) {}

  speak(text: string): void {
    const settings = this.settings();
    if (!settings.speak) return;
    const clean = text.replace(/^[\s-]+/, "").trim();
    if (!clean) return;
    this.queue = this.queue.then(() => this.say(clean, settings)).catch(() => undefined);
  }

  private async say(text: string, settings: Settings): Promise<void> {
    if (this.host.spawn) {
      try {
        const args = settings.voice ? ["-v", settings.voice, text] : [text];
        this.current = await this.host.spawn("say", { args });
        await this.current.end();
        await this.current.exited;
        this.current = null;
        return;
      } catch {
        this.current = null;
      }
    }
    if (typeof speechSynthesis === "undefined") return;
    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    this.queue = Promise.resolve();
    void this.current?.kill();
    this.current = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }
}

const TARGET_RATE = 16000;
const MAX_SECONDS = 120;

const PREROLL_SECONDS = 0.6;
const IDLE_RELEASE_MS = 10 * 60_000;

export class Recorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private opening: Promise<void> | null = null;
  private deviceId = "";
  private capturing = false;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onLevel: (level: number) => void = () => {};
  level = 0;

  get active(): boolean {
    return this.capturing;
  }

  get open(): boolean {
    return this.stream !== null;
  }

  async warm(deviceId: string): Promise<void> {
    if (this.stream && this.deviceId === deviceId) {
      this.armIdle();
      return;
    }
    if (this.opening && this.deviceId === deviceId) return this.opening;
    this.release();
    this.deviceId = deviceId;
    this.opening = this.openStream(deviceId).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openStream(deviceId: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not available here.");
    const audio: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (this.deviceId !== deviceId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const Context = window.AudioContext ?? (window as any).webkitAudioContext;
    const context: AudioContext = new Context();
    const source = context.createMediaStreamSource(stream);
    const node = context.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (event) => {
      const input = new Float32Array(event.inputBuffer.getChannelData(0));
      if (this.capturing) {
        if (this.samples < context.sampleRate * MAX_SECONDS) {
          this.chunks.push(input);
          this.samples += input.length;
        }
        let peak = 0;
        for (let i = 0; i < input.length; i += 16) peak = Math.max(peak, Math.abs(input[i]));
        this.level = peak;
        this.onLevel(peak);
      } else {
        this.preroll.push(input);
        this.prerollSamples += input.length;
        while (this.prerollSamples - (this.preroll[0]?.length ?? 0) > context.sampleRate * PREROLL_SECONDS) {
          this.prerollSamples -= this.preroll.shift()!.length;
        }
      }
    };
    source.connect(node);
    node.connect(context.destination);
    this.stream = stream;
    this.context = context;
    this.node = node;
    if (context.state === "suspended") await context.resume();
    stream.getTracks().forEach((track) => track.addEventListener("ended", () => this.release()));
    this.armIdle();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.capturing) this.release();
    }, IDLE_RELEASE_MS);
  }

  async start(onLevel: (level: number) => void, deviceId = ""): Promise<void> {
    if (this.capturing) return;
    await this.warm(deviceId);
    if (!this.context) throw new Error("The microphone did not open.");
    if (this.context.state === "suspended") await this.context.resume();
    this.onLevel = onLevel;
    this.chunks = [...this.preroll];
    this.samples = this.prerollSamples;
    this.preroll = [];
    this.prerollSamples = 0;
    this.capturing = true;
  }

  async stop(): Promise<{ base64: string; seconds: number; peak: number } | null> {
    const context = this.context;
    if (!context || !this.capturing) return null;
    this.capturing = false;
    this.level = 0;
    this.armIdle();
    const rate = context.sampleRate;
    const merged = new Float32Array(this.samples);
    let at = 0;
    for (const chunk of this.chunks) {
      const take = Math.min(chunk.length, merged.length - at);
      merged.set(chunk.subarray(0, take), at);
      at += take;
      if (at >= merged.length) break;
    }
    this.chunks = [];
    this.samples = 0;
    const pcm = resample(merged, rate, TARGET_RATE);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 1) peak = Math.max(peak, Math.abs(pcm[i]));
    return { base64: toBase64(wav(pcm, TARGET_RATE)), seconds: pcm.length / TARGET_RATE, peak };
  }

  cancel(): void {
    this.capturing = false;
    this.chunks = [];
    this.samples = 0;
  }

  release(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.capturing = false;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => undefined);
    this.stream = null;
    this.context = null;
    this.node = null;
    this.chunks = [];
    this.preroll = [];
    this.prerollSamples = 0;
  }
}

export async function listMicrophones(): Promise<{ id: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    out[i] = sum / (end - start);
  }
  return out;
}

export function wav(samples: Float32Array, rate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
