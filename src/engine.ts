import LISTEN_PY from "../scripts/listen.py";
import TTS_PY from "../scripts/tts.py";
import { attachCapture, AudioPlayer, fromBase64, type CaptureHandle, type CueKind } from "./audio";
import { SseParser, type StreamResult } from "./stream";

const TARGET_RATE = 16000;
/** 32 ms frames (512 samples @ 16 kHz) match Silero VAD's exact window size for minimal latency. */
const TAP_SAMPLES = 512;

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

export type SttBackend = "local" | "openai";
export type TtsBackend = "system" | "openai" | "local";

export interface Settings {
  modelDir: string;
  whisper: string;
  sttBackend: SttBackend;
  sttUrl: string;
  sttModel: string;
  sttKey: string;
  llmUrl: string;
  llmModel: string;
  llmKey: string;
  voice: string;
  speak: boolean;
  ttsBackend: TtsBackend;
  ttsUrl: string;
  ttsModel: string;
  ttsVoice: string;
  ttsKey: string;
  ttsSpeed: number;
  localTtsModel: string;
  localTtsSpeaker: number;
  microphone: string;
  handsFree: boolean;
  wakeWord: string;
  vadSilenceMs: number;
  bargeIn: boolean;
  confirmBeforeSend: boolean;
  audioCues: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  modelDir: "~/buzz-voice-models",
  whisper: "small.en",
  sttBackend: "local",
  sttUrl: "",
  sttModel: "whisper-1",
  sttKey: "",
  llmUrl: "",
  llmModel: "",
  llmKey: "",
  voice: "",
  speak: true,
  ttsBackend: "system",
  ttsUrl: "",
  ttsModel: "kokoro",
  ttsVoice: "af_heart",
  ttsKey: "",
  ttsSpeed: 1.0,
  localTtsModel: "kokoro-en-v0_19",
  localTtsSpeaker: 0,
  microphone: "",
  handsFree: false,
  wakeWord: "buzz",
  vadSilenceMs: 420,
  bargeIn: true,
  confirmBeforeSend: true,
  audioCues: true,
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
  signal?: AbortSignal,
): Promise<Run> {
  if (!host.spawn) throw new Error("This Buzz build cannot start local processes.");
  if (signal?.aborted) throw new Error("Aborted");
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
  const onAbort = () => {
    void process.kill().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await process.end(input ?? "");
    const code = await process.exited;
    if (signal?.aborted) throw new Error("Aborted");
    return { code, stdout, stderr };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface SystemVoice {
  name: string;
  locale: string;
}

export function parseVoices(stdout: string): SystemVoice[] {
  const voices: SystemVoice[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9_-]+)\s+#/.exec(line);
    if (match) voices.push({ name: match[1].trim(), locale: match[2].replace("-", "_") });
  }
  return voices;
}

export async function listVoices(host: Host): Promise<SystemVoice[]> {
  const result = await run(host, "say", ["-v", "?"]);
  return parseVoices(result.stdout);
}

export interface EngineStatus {
  engine: boolean;
  model: boolean;
  runtime: boolean;
  ttsModel: boolean;
  buzzVoice: Record<string, unknown> | null;
}

function parseStatus(stdout: string, runtime: boolean, ttsModel: boolean): EngineStatus {
  const at = stdout.indexOf('{"engine"');
  if (at < 0) throw new Error("The setup script returned nothing.");
  const parsed = JSON.parse(stdout.slice(at).trim());
  return { engine: !!parsed.engine, model: !!parsed.model, runtime, ttsModel, buzzVoice: parsed.buzzVoice ?? null };
}

async function runtimeReady(host: Host, settings: Settings, install: boolean, onLine?: (line: string) => void): Promise<boolean> {
  try {
    const result = await run(host, "runtime", [settings.modelDir, install ? "install" : "check"], "", onLine);
    return /"runtime":true/.test(result.stdout);
  } catch {
    return false;
  }
}

export async function checkTtsModel(host: Host, settings: Settings): Promise<boolean> {
  try {
    const result = await run(host, "tts-setup", [settings.modelDir, "check", settings.localTtsModel || "kokoro-en-v0_19"]);
    return /"ttsModel":true/.test(result.stdout);
  } catch {
    return false;
  }
}

export async function installTtsModel(
  host: Host,
  settings: Settings,
  progress?: (step: string) => void,
): Promise<boolean> {
  const runtime = await runtimeReady(host, settings, true, (line) => {
    if (line.startsWith("progress ")) progress?.(line.slice(9));
  });
  if (!runtime) throw new Error("Python speech runtime could not be installed.");
  const result = await run(
    host,
    "tts-setup",
    [settings.modelDir, "install", settings.localTtsModel || "kokoro-en-v0_19"],
    "",
    (line) => {
      if (line.startsWith("progress ")) progress?.(line.slice(9));
    },
  );
  if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").pop() || "TTS model install failed.");
  return /"ttsModel":true/.test(result.stdout);
}

export async function checkEngine(host: Host, settings: Settings): Promise<EngineStatus> {
  const [result, runtime, ttsModel] = await Promise.all([
    run(host, "setup", [settings.modelDir, "check", settings.whisper]),
    runtimeReady(host, settings, false),
    checkTtsModel(host, settings),
  ]);
  return parseStatus(result.stdout, runtime, ttsModel);
}

export async function installRuntime(
  host: Host,
  settings: Settings,
  progress?: (step: string) => void,
): Promise<boolean> {
  const ok = await runtimeReady(host, settings, true, (line) => {
    if (line.startsWith("progress ")) progress?.(line.slice(9));
  });
  if (!ok) throw new Error("Fast speech runtime could not be installed. Make sure python3 is available.");
  return true;
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
  const runtime = await runtimeReady(host, settings, true, (line) => {
    if (line.startsWith("progress ")) progress(line.slice(9));
  });
  const ttsModel = await checkTtsModel(host, settings);
  return parseStatus(result.stdout, runtime, ttsModel);
}

export async function transcribe(host: Host, settings: Settings, wavBase64: string): Promise<string> {
  if (settings.sttBackend === "openai" && settings.sttUrl.trim()) {
    const base = settings.sttUrl.trim().replace(/\/+$/, "");
    const url = /\/audio\/transcriptions$/.test(base) ? base : `${base}/audio/transcriptions`;
    const result = await run(host, "stt-http", [url, settings.sttModel.trim() || "whisper-1", settings.sttKey.trim()], wavBase64);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim().split("\n").pop() || `STT request failed (${result.code}).`);
    }
    const raw = result.stdout.trim();
    try {
      const parsed = JSON.parse(raw);
      return String(parsed.text ?? "").trim();
    } catch {
      return raw;
    }
  }
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

function chatUrl(settings: Settings): string {
  const base = settings.llmUrl.trim().replace(/\/+$/, "");
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

export function llmPoster(host: Host, settings: Settings) {
  return async (body: unknown): Promise<string> => {
    const url = chatUrl(settings);
    const args = settings.llmKey ? ["-H", `Authorization: Bearer ${settings.llmKey}`, url] : [url];
    const result = await run(host, "llm", args, JSON.stringify(body));
    if (result.code !== 0) throw new Error(result.stderr.trim() || `The LLM call failed (${result.code}).`);
    return result.stdout;
  };
}

/** Streams an OpenAI-compatible Chat Completions request via `curl -N`, abortable on barge-in. */
export async function llmStream(
  host: Host,
  settings: Settings,
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  if (!host.spawn) throw new Error("This Buzz build cannot start local processes.");
  if (signal?.aborted) throw new Error("Aborted");
  const url = chatUrl(settings);
  const args = ["-N", ...(settings.llmKey ? ["-H", `Authorization: Bearer ${settings.llmKey}`] : []), url];
  const parser = new SseParser(onDelta);
  let stderr = "";
  const process = await host.spawn("llm", {
    args,
    onStdout: (data) => parser.feed(data),
    onStderr: (data) => {
      stderr = (stderr + data).slice(-4000);
    },
  });
  const onAbort = () => {
    void process.kill().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await process.end(JSON.stringify({ ...body, stream: true }));
    const code = await process.exited;
    if (signal?.aborted) throw new Error("Aborted");
    if (code !== 0) throw new Error(stderr.trim() || `The LLM call failed (${code}).`);
    return parser.finish();
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

const DECODE_CHUNK = TARGET_RATE * 10;

export function pcmBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return toBase64(bytes);
}

export type Heard =
  | { kind: "speech"; active: boolean }
  | { kind: "text"; text: string; ms: number }
  | { kind: "error"; message: string };

export class Listener {
  private process: HostProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private key = "";
  private nextId = 1;
  private waiting = new Map<string, { resolve(text: string): void; reject(error: Error): void }>();
  private generation = 0;
  private abandon: () => void = () => {};
  onHeard: (heard: Heard) => void = () => {};
  /** The recogniser exited without being asked to. */
  onExit: () => void = () => {};

  constructor(private readonly host: Host) {}

  get running(): boolean {
    return this.process !== null;
  }

  async ensure(settings: Settings, silenceSec = 0.6): Promise<boolean> {
    const key = `${settings.modelDir}|${settings.sttBackend === "openai" ? "__none__" : settings.whisper}`;
    if (this.process && this.key === key) {
      this.configure(settings, silenceSec);
      return true;
    }
    if (this.starting && this.key === key) {
      const ok = await this.starting;
      if (ok) this.configure(settings, silenceSec);
      return ok;
    }
    this.stop();
    this.key = key;
    this.starting = this.launch(settings, silenceSec).finally(() => {
      this.starting = null;
    });
    const ok = await this.starting;
    if (ok) this.configure(settings, silenceSec);
    return ok;
  }

  configure(settings: Settings, silenceSec: number): void {
    if (!this.process) return;
    const payload = JSON.stringify({
      stt_mode: settings.sttBackend,
      stt_url: settings.sttUrl.trim(),
      stt_model: settings.sttModel.trim() || "whisper-1",
      stt_key: settings.sttKey.trim(),
      whisper: settings.whisper.trim() || "small.en",
      silence: Math.max(0.15, Math.min(2.0, silenceSec)),
    });
    void this.process.write(`c ${payload}\n`).catch(() => undefined);
  }

  setSilence(silenceSec: number): void {
    void this.process?.write(`s ${Math.max(0.15, Math.min(2.0, silenceSec)).toFixed(2)}\n`).catch(() => undefined);
  }

  private async launch(settings: Settings, silenceSec: number): Promise<boolean> {
    if (!this.host.spawn) return false;
    const generation = ++this.generation;
    let partial = "";
    let ready: (ok: boolean) => void = () => {};
    const started = new Promise<boolean>((resolve) => {
      ready = resolve;
    });
    this.abandon = () => ready(false);
    const whisperArg = settings.sttBackend === "openai" ? "__none__" : settings.whisper;
    const process = await this.host.spawn("listen", {
      args: [settings.modelDir, whisperArg, String(silenceSec), LISTEN_PY],
      onStdout: (data) => {
        partial += data;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) this.line(line, ready);
      },
    });
    if (generation !== this.generation) {
      void process.kill().catch(() => undefined);
      return false;
    }
    this.process = process;
    void process.exited.then(() => {
      if (this.process !== process) return;
      this.process = null;
      ready(false);
      this.fail();
      this.onExit();
    });
    const ok = await started;
    if (!ok && this.process === process) this.stop();
    return ok;
  }

  private line(line: string, ready: (ok: boolean) => void): void {
    if (!line.startsWith("{")) return;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed.ready) return ready(true);
    if (parsed.configured) return;
    if (parsed.error === "no-runtime") return ready(false);
    if (typeof parsed.id === "string") {
      const waiter = this.waiting.get(parsed.id);
      this.waiting.delete(parsed.id);
      if (parsed.error) waiter?.reject(new Error(parsed.error));
      else waiter?.resolve(String(parsed.text ?? "").trim());
      return;
    }
    if (typeof parsed.speech === "boolean") this.onHeard({ kind: "speech", active: parsed.speech });
    else if (typeof parsed.text === "string") this.onHeard({ kind: "text", text: parsed.text.trim(), ms: parsed.ms ?? 0 });
    else if (parsed.error) this.onHeard({ kind: "error", message: String(parsed.error) });
  }

  feed(pcmBase64: string): void {
    void this.process?.write(`a ${pcmBase64}\n`).catch(() => undefined);
  }

  reset(): void {
    void this.process?.write("r\n").catch(() => undefined);
  }

  async decode(pcm: Float32Array): Promise<string> {
    const process = this.process;
    if (!process) throw new Error("Speech recognition is not running.");
    const id = String(this.nextId++);
    const result = new Promise<string>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    try {
      for (let at = 0; at < pcm.length; at += DECODE_CHUNK) {
        await process.write(`p ${id} ${pcmBase64(pcm.subarray(at, at + DECODE_CHUNK))}\n`);
      }
      await process.write(`d ${id}\n`);
    } catch (error) {
      this.waiting.delete(id);
      result.catch(() => undefined);
      throw error;
    }
    return result;
  }

  private fail(): void {
    for (const waiter of this.waiting.values()) waiter.reject(new Error("Speech recognition stopped."));
    this.waiting.clear();
  }

  stop(): void {
    const process = this.process;
    this.process = null;
    this.generation += 1;
    this.abandon();
    this.fail();
    void process?.kill().catch(() => undefined);
  }
}

/** Persistent local neural TTS daemon (sherpa-onnx Kokoro / Piper VITS). */
export class LocalTts {
  private process: HostProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private key = "";
  private nextId = 1;
  private waiting = new Map<string, { resolve(res: { rate: number; pcm: Uint8Array }): void; reject(err: Error): void }>();
  private generation = 0;
  private abandon: () => void = () => {};
  speakers = 1;
  sampleRate = 24000;

  constructor(private readonly host: Host) {}

  async ensure(settings: Settings): Promise<boolean> {
    const model = settings.localTtsModel.trim() || "kokoro-en-v0_19";
    const key = `${settings.modelDir}|${model}`;
    if (this.process && this.key === key) return true;
    if (this.starting && this.key === key) return this.starting;
    this.stop();
    this.key = key;
    this.starting = this.launch(settings.modelDir, model).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(modelDir: string, model: string): Promise<boolean> {
    if (!this.host.spawn) return false;
    const generation = ++this.generation;
    let partial = "";
    let ready: (ok: boolean) => void = () => {};
    const started = new Promise<boolean>((resolve) => {
      ready = resolve;
    });
    this.abandon = () => ready(false);
    const process = await this.host.spawn("tts-local", {
      args: [modelDir, model, TTS_PY],
      onStdout: (data) => {
        partial += data;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) this.handleLine(line, ready);
      },
    });
    if (generation !== this.generation) {
      void process.kill().catch(() => undefined);
      return false;
    }
    this.process = process;
    void process.exited.then(() => {
      if (this.process !== process) return;
      this.process = null;
      ready(false);
      this.fail();
    });
    const ok = await started;
    if (!ok && this.process === process) this.stop();
    return ok;
  }

  private handleLine(line: string, ready: (ok: boolean) => void): void {
    if (!line.startsWith("{")) return;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed.ready) {
      this.sampleRate = Number(parsed.rate) || 24000;
      this.speakers = Number(parsed.speakers) || 1;
      return ready(true);
    }
    if (parsed.error && !parsed.id) return ready(false);
    if (typeof parsed.id === "string") {
      const waiter = this.waiting.get(parsed.id);
      this.waiting.delete(parsed.id);
      if (parsed.error) waiter?.reject(new Error(parsed.error));
      else waiter?.resolve({ rate: Number(parsed.rate) || this.sampleRate, pcm: fromBase64(String(parsed.pcm ?? "")) });
    }
  }

  async synthesize(text: string, sid: number, speed: number): Promise<{ rate: number; pcm: Uint8Array }> {
    const process = this.process;
    if (!process) throw new Error("Local TTS is not running.");
    const id = String(this.nextId++);
    const result = new Promise<{ rate: number; pcm: Uint8Array }>((resolve, reject) =>
      this.waiting.set(id, { resolve, reject }),
    );
    try {
      await process.write(`${JSON.stringify({ id, text, sid, speed })}\n`);
    } catch (error) {
      this.waiting.delete(id);
      result.catch(() => undefined);
      throw error;
    }
    return result;
  }

  private fail(): void {
    for (const waiter of this.waiting.values()) waiter.reject(new Error("Local TTS stopped."));
    this.waiting.clear();
  }

  stop(): void {
    const process = this.process;
    this.process = null;
    this.generation += 1;
    this.abandon();
    this.fail();
    void process?.kill().catch(() => undefined);
  }
}

type SynthItem =
  | { kind: "buffer"; buffer: AudioBuffer }
  | { kind: "fallback"; text: string };

/**
 * Pipelined, interruptible TTS speaker.
 * Synthesizes upcoming sentences concurrently while current audio plays through WebAudio
 * so browser AEC cancels output and barge-in halts playback in <5ms.
 */
export class Speaker {
  private readonly player = new AudioPlayer();
  private readonly localTts: LocalTts;
  private activeAbort = new AbortController();
  private currentLegacy: HostProcess | null = null;
  private playChain: Promise<void> = Promise.resolve();
  private queued = 0;
  private generation = 0;
  onIdle: () => void = () => {};
  onStateChange: (speaking: boolean) => void = () => {};
  onError: (message: string) => void = () => {};

  get speaking(): boolean {
    return this.queued > 0 || this.player.playing;
  }

  constructor(
    private readonly host: Host,
    private readonly settings: () => Settings,
  ) {
    this.localTts = new LocalTts(host);
  }

  setSharedAudioContext(getter: () => AudioContext | null): void {
    this.player.setSharedContext(getter);
  }

  cue(kind: CueKind): void {
    if (this.settings().audioCues) this.player.cue(kind);
  }

  /** Pre-warms local sherpa-onnx TTS model in RAM if selected. */
  async warm(): Promise<void> {
    const settings = this.settings();
    if (settings.ttsBackend === "local") {
      await this.localTts.ensure(settings).catch(() => undefined);
    }
  }

  speak(text: string, force = false): void {
    const settings = this.settings();
    if (!settings.speak && !force) return;
    const clean = text.replace(/^[\s-]+/, "").trim();
    if (!clean) return;

    const wasSpeaking = this.speaking;
    this.queued += 1;
    if (!wasSpeaking) this.onStateChange(true);

    const generation = this.generation;
    const playerGen = this.player.currentGeneration;
    const signal = this.activeAbort.signal;

    // Start synthesis immediately (pipelined ahead of playback of earlier sentences!)
    const synthPromise = this.synthesize(clean, settings, signal);
    // Prevent unhandledrejection if synthesis fails before earlier items finish playing
    void synthPromise.catch(() => undefined);

    this.playChain = this.playChain
      .then(async () => {
        if (generation !== this.generation || signal.aborted) return;
        const item = await synthPromise;
        if (!item || generation !== this.generation || signal.aborted) return;
        if (item.kind === "buffer") {
          await this.player.playBuffer(item.buffer, playerGen);
        } else {
          await this.legacySay(item.text, settings, generation);
        }
      })
      .catch((error) => {
        if (generation === this.generation && !signal.aborted) {
          this.onError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (generation === this.generation) this.done();
      });
  }

  private async synthesize(text: string, settings: Settings, signal: AbortSignal): Promise<SynthItem | null> {
    if (signal.aborted) return null;
    const speed = Math.max(0.5, Math.min(2.0, Number(settings.ttsSpeed) || 1.0));

    // 1. OpenAI-compatible /v1/audio/speech (Kokoro-FastAPI, Speaches, Piper HTTP, OpenAI, etc.)
    if (settings.ttsBackend === "openai" && settings.ttsUrl.trim()) {
      const base = settings.ttsUrl.trim().replace(/\/+$/, "");
      const url = /\/audio\/speech$/.test(base) ? base : `${base}/audio/speech`;
      const payload = JSON.stringify({
        model: settings.ttsModel.trim() || "kokoro",
        input: text,
        voice: settings.ttsVoice.trim() || "af_heart",
        response_format: "wav",
        speed,
      });
      const result = await run(this.host, "tts-http", [url, settings.ttsKey.trim()], payload, undefined, signal);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim().split("\n").pop() || `TTS HTTP failed (${result.code}).`);
      }
      const bytes = fromBase64(result.stdout);
      const buffer = await this.player.decodeBytes(bytes, 24000);
      return buffer ? { kind: "buffer", buffer } : null;
    }

    // 2. Local sherpa-onnx neural TTS (Kokoro / Piper VITS)
    if (settings.ttsBackend === "local") {
      const ok = await this.localTts.ensure(settings);
      if (!ok) {
        throw new Error("Local TTS model is not installed. Install it in Buzz Voice Settings.");
      }
      const audio = await this.localTts.synthesize(text, Number(settings.localTtsSpeaker) || 0, speed);
      if (signal.aborted) return null;
      const buffer = await this.player.decodePcm16(audio.pcm, audio.rate);
      return buffer ? { kind: "buffer", buffer } : null;
    }

    // 3. System voice rendered to WAV for WebAudio AEC + instant barge-in
    if (this.host.spawn) {
      try {
        const rateWpm = String(Math.round(190 * speed));
        const attempts = settings.voice ? [[settings.voice, rateWpm], ["", rateWpm]] : [["", rateWpm]];
        for (const args of attempts) {
          if (signal.aborted) return null;
          const result = await run(this.host, "tts-say", args, text, undefined, signal);
          if (result.code === 0 && result.stdout.trim()) {
            const buffer = await this.player.decodeBytes(fromBase64(result.stdout), 24000);
            if (buffer) return { kind: "buffer", buffer };
          }
          if (result.code === 127) break; // say not present on this OS
        }
      } catch (err) {
        if (signal.aborted) return null;
      }
    }

    return { kind: "fallback", text };
  }

  private async legacySay(text: string, settings: Settings, generation: number): Promise<void> {
    if (this.host.spawn) {
      try {
        for (const args of settings.voice ? [["-v", settings.voice, text], [text]] : [[text]]) {
          if (generation !== this.generation) return;
          this.currentLegacy = await this.host.spawn("say", { args });
          await this.currentLegacy.end();
          const code = await this.currentLegacy.exited;
          this.currentLegacy = null;
          if (code === 0 || generation !== this.generation) return;
        }
      } catch {
        this.currentLegacy = null;
      }
    }
    if (typeof speechSynthesis === "undefined") return;
    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = Math.max(0.5, Math.min(2.0, Number(settings.ttsSpeed) || 1.0));
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      speechSynthesis.speak(utterance);
    });
  }

  private done(): void {
    if (this.queued === 0) return;
    this.queued -= 1;
    if (this.queued === 0) {
      this.onStateChange(false);
      this.onIdle();
    }
  }

  stop(): void {
    const was = this.speaking;
    this.queued = 0;
    this.generation += 1;
    this.activeAbort.abort();
    this.activeAbort = new AbortController();
    this.playChain = Promise.resolve();
    this.player.stop();
    void this.currentLegacy?.kill().catch(() => undefined);
    this.currentLegacy = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    if (was) {
      this.onStateChange(false);
      this.onIdle();
    }
  }

  dispose(): void {
    this.stop();
    this.localTts.stop();
    this.player.close();
  }
}

const MAX_SECONDS = 120;
const PREROLL_SECONDS = 0.6;
const IDLE_RELEASE_MS = 10 * 60_000;

export class Recorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private capture: CaptureHandle | null = null;
  private opening: Promise<void> | null = null;
  private deviceId = "";
  private capturing = false;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onLevel: (level: number) => void = () => {};
  private tap: ((pcm: Float32Array) => void) | null = null;
  /** The microphone closed while hands-free or live mode was streaming from it. */
  onLost: () => void = () => {};
  private tapped: Float32Array[] = [];
  private tappedSamples = 0;
  level = 0;

  get active(): boolean {
    return this.capturing;
  }

  get open(): boolean {
    return this.stream !== null;
  }

  get audioContext(): AudioContext | null {
    return this.context;
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
    const capture = await attachCapture(context, source, (input) => {
      if (this.tap) this.feedTap(resample(input, context.sampleRate, TARGET_RATE));
      if (this.capturing) {
        if (this.samples < context.sampleRate * MAX_SECONDS) {
          this.chunks.push(input);
          this.samples += input.length;
        }
        let peak = 0;
        for (let i = 0; i < input.length; i += 8) peak = Math.max(peak, Math.abs(input[i]));
        this.level = peak;
        this.onLevel(peak);
      } else {
        this.preroll.push(input);
        this.prerollSamples += input.length;
        while (this.prerollSamples - (this.preroll[0]?.length ?? 0) > context.sampleRate * PREROLL_SECONDS) {
          this.prerollSamples -= this.preroll.shift()!.length;
        }
      }
    });
    if (this.deviceId !== deviceId) {
      capture.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
      return;
    }
    this.stream = stream;
    this.context = context;
    this.capture = capture;
    if (context.state === "suspended") await context.resume();
    stream.getTracks().forEach((track) =>
      track.addEventListener("ended", () => {
        if (this.stream !== stream) return;
        const tapped = this.tap !== null;
        this.release();
        if (tapped) this.onLost();
      }),
    );
    this.armIdle();
  }

  /** Streams 16 kHz audio in low-latency 32 ms frames while set, and keeps the microphone open. */
  async listen(tap: ((pcm: Float32Array) => void) | null, deviceId = "", onLevel?: (level: number) => void): Promise<void> {
    this.tap = tap;
    if (onLevel) this.onLevel = onLevel;
    this.tapped = [];
    this.tappedSamples = 0;
    if (tap) await this.warm(deviceId);
    else this.armIdle();
  }

  private feedTap(pcm: Float32Array): void {
    this.tapped.push(pcm);
    this.tappedSamples += pcm.length;
    if (this.tappedSamples < TAP_SAMPLES) return;
    const frame = new Float32Array(this.tappedSamples);
    let at = 0;
    for (const chunk of this.tapped) {
      frame.set(chunk, at);
      at += chunk.length;
    }
    this.tapped = [];
    this.tappedSamples = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i += 8) peak = Math.max(peak, Math.abs(frame[i]));
    this.level = peak;
    if (!this.capturing) this.onLevel(peak);
    this.tap?.(frame);
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.capturing && !this.tap) this.release();
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

  async stop(): Promise<{ base64: string; pcm: Float32Array; seconds: number; peak: number } | null> {
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
    return { base64: toBase64(wav(pcm, TARGET_RATE)), pcm, seconds: pcm.length / TARGET_RATE, peak };
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
    this.tap = null;
    this.capture?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => undefined);
    this.stream = null;
    this.context = null;
    this.capture = null;
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
