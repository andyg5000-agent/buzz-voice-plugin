// Built from src/ by build.mjs. Edit the TypeScript, then run npm run build.
var __defProp = Object.defineProperty;
var __export = (target, all2) => {
  for (var name in all2)
    __defProp(target, name, { get: all2[name], enumerable: true });
};

// scripts/listen.py
var listen_default = 'import base64, json, os, sys, time\nimport numpy as np\nimport sherpa_onnx\n\nd, n = sys.argv[1], sys.argv[2]\nsilence = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6\nrate = 16000\nw = os.path.join(d, f"sherpa-onnx-whisper-{n}", n)\n\n\ndef out(**msg):\n    sys.stdout.write(json.dumps(msg) + "\\n")\n    sys.stdout.flush()\n\n\nstarted = time.time()\nrecognizer = sherpa_onnx.OfflineRecognizer.from_whisper(\n    encoder=f"{w}-encoder.int8.onnx",\n    decoder=f"{w}-decoder.int8.onnx",\n    tokens=f"{w}-tokens.txt",\n    language="en",\n    task="transcribe",\n    num_threads=4,\n)\nconfig = sherpa_onnx.VadModelConfig()\nconfig.silero_vad.model = os.path.join(d, "silero_vad.onnx")\nconfig.silero_vad.threshold = 0.5\nconfig.silero_vad.min_silence_duration = silence\nconfig.silero_vad.min_speech_duration = 0.25\nconfig.silero_vad.max_speech_duration = 30\nconfig.sample_rate = rate\nwindow = config.silero_vad.window_size\nvad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=120)\npending = np.zeros(0, dtype=np.float32)\nspeaking = False\nparts = {}\n\n\ndef decode(samples):\n    t = time.time()\n    stream = recognizer.create_stream()\n    stream.accept_waveform(rate, samples)\n    recognizer.decode_stream(stream)\n    return stream.result.text.strip(), int((time.time() - t) * 1000)\n\n\ndef pcm(data):\n    return np.frombuffer(base64.b64decode(data), dtype="<i2").astype(np.float32) / 32768\n\n\nout(ready=True, ms=int((time.time() - started) * 1000))\nfor line in sys.stdin:\n    op, _, rest = line.strip().partition(" ")\n    try:\n        if op == "a":\n            pending = np.concatenate([pending, pcm(rest)])\n            while len(pending) >= window:\n                vad.accept_waveform(pending[:window])\n                pending = pending[window:]\n                if vad.is_speech_detected() != speaking:\n                    speaking = not speaking\n                    out(speech=speaking)\n                while not vad.empty():\n                    samples = np.array(vad.front.samples, dtype=np.float32)\n                    vad.pop()\n                    text, ms = decode(samples)\n                    out(text=text, ms=ms, seconds=round(len(samples) / rate, 2))\n        elif op == "p":\n            ref, _, data = rest.partition(" ")\n            parts.setdefault(ref, []).append(pcm(data))\n        elif op == "d":\n            ref = rest\n            chunks = parts.pop(ref, [])\n            samples = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)\n            text, ms = decode(samples)\n            out(id=ref, text=text, ms=ms)\n        elif op == "r":\n            vad.reset()\n            pending = np.zeros(0, dtype=np.float32)\n            if speaking:\n                speaking = False\n                out(speech=False)\n    except Exception as error:\n        if op == "d":\n            out(id=rest, error=str(error))\n        else:\n            out(error=str(error))\n';

// src/engine.ts
var TARGET_RATE = 16e3;
var TAP_SAMPLES = TARGET_RATE / 10;
var DEFAULT_SETTINGS = {
  modelDir: "~/buzz-voice-models",
  whisper: "small.en",
  llmUrl: "",
  llmModel: "",
  llmKey: "",
  voice: "",
  speak: true,
  microphone: "",
  handsFree: false,
  wakeWord: "buzz"
};
var SETTINGS_KEY = "buzz-voice-plugin.settings";
function storage() {
  try {
    return typeof localStorage === "undefined" ? void 0 : localStorage;
  } catch {
    return void 0;
  }
}
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(storage()?.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(settings) {
  storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
function loadJson(key, fallback) {
  try {
    const value = storage()?.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  storage()?.setItem(key, JSON.stringify(value));
}
async function run(host, id, args, input, onLine) {
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
      for (const line2 of lines) onLine(line2);
    },
    onStderr: (data) => {
      stderr = (stderr + data).slice(-4e3);
    }
  });
  await process.end(input ?? "");
  const code = await process.exited;
  return { code, stdout, stderr };
}
function parseStatus(stdout, runtime) {
  const at = stdout.indexOf('{"engine"');
  if (at < 0) throw new Error("The setup script returned nothing.");
  const parsed = JSON.parse(stdout.slice(at).trim());
  return { engine: !!parsed.engine, model: !!parsed.model, runtime, buzzVoice: parsed.buzzVoice ?? null };
}
async function runtimeReady(host, settings, install, onLine) {
  try {
    const result = await run(host, "runtime", [settings.modelDir, install ? "install" : "check"], "", onLine);
    return /"runtime":true/.test(result.stdout);
  } catch {
    return false;
  }
}
async function checkEngine(host, settings) {
  const [result, runtime] = await Promise.all([
    run(host, "setup", [settings.modelDir, "check", settings.whisper]),
    runtimeReady(host, settings, false)
  ]);
  return parseStatus(result.stdout, runtime);
}
async function installEngine(host, settings, progress) {
  const result = await run(host, "setup", [settings.modelDir, "install", settings.whisper], "", (line2) => {
    if (line2.startsWith("progress ")) progress(line2.slice(9));
  });
  if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").pop() || "Install failed.");
  const runtime = await runtimeReady(host, settings, true, (line2) => {
    if (line2.startsWith("progress ")) progress(line2.slice(9));
  });
  return parseStatus(result.stdout, runtime);
}
async function transcribe(host, settings, wavBase64) {
  const result = await run(host, "stt", [settings.modelDir, settings.whisper], wavBase64);
  const line2 = result.stdout.split("\n").filter((l) => l.startsWith("{")).pop();
  if (!line2) {
    const why = result.stderr.trim().split("\n").pop();
    throw new Error(`Speech recognition failed${why ? `: ${why}` : "."}`);
  }
  const parsed = JSON.parse(line2);
  if (parsed.error === "no-engine") throw new Error("The speech engine is not installed. Open Settings to install it.");
  if (parsed.error === "no-model") throw new Error("The whisper model is missing. Open Settings to install it.");
  return String(parsed.text ?? "").trim();
}
function llmPoster(host, settings) {
  return async (body) => {
    const base = settings.llmUrl.replace(/\/+$/, "");
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    const args = settings.llmKey ? ["-H", `Authorization: Bearer ${settings.llmKey}`, url] : [url];
    const result = await run(host, "llm", args, JSON.stringify(body));
    if (result.code !== 0) throw new Error(result.stderr.trim() || `The LLM call failed (${result.code}).`);
    return result.stdout;
  };
}
var DECODE_CHUNK = TARGET_RATE * 10;
function pcmBase64(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return toBase64(bytes);
}
var Listener = class {
  constructor(host) {
    this.host = host;
  }
  process = null;
  starting = null;
  key = "";
  nextId = 1;
  waiting = /* @__PURE__ */ new Map();
  generation = 0;
  abandon = () => {
  };
  onHeard = () => {
  };
  /** The recogniser exited without being asked to. */
  onExit = () => {
  };
  get running() {
    return this.process !== null;
  }
  async ensure(settings) {
    const key = `${settings.modelDir}|${settings.whisper}`;
    if (this.process && this.key === key) return true;
    if (this.starting && this.key === key) return this.starting;
    this.stop();
    this.key = key;
    this.starting = this.launch(settings).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async launch(settings) {
    if (!this.host.spawn) return false;
    const generation = ++this.generation;
    let partial = "";
    let ready = () => {
    };
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    this.abandon = () => ready(false);
    const process = await this.host.spawn("listen", {
      args: [settings.modelDir, settings.whisper, "0.6", listen_default],
      onStdout: (data) => {
        partial += data;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line2 of lines) this.line(line2, ready);
      }
    });
    if (generation !== this.generation) {
      void process.kill().catch(() => void 0);
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
  line(line2, ready) {
    if (!line2.startsWith("{")) return;
    let parsed;
    try {
      parsed = JSON.parse(line2);
    } catch {
      return;
    }
    if (parsed.ready) return ready(true);
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
  feed(pcmBase642) {
    void this.process?.write(`a ${pcmBase642}
`).catch(() => void 0);
  }
  reset() {
    void this.process?.write("r\n").catch(() => void 0);
  }
  async decode(pcm) {
    const process = this.process;
    if (!process) throw new Error("Speech recognition is not running.");
    const id = String(this.nextId++);
    const result = new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    try {
      for (let at = 0; at < pcm.length; at += DECODE_CHUNK) {
        await process.write(`p ${id} ${pcmBase64(pcm.subarray(at, at + DECODE_CHUNK))}
`);
      }
      await process.write(`d ${id}
`);
    } catch (error) {
      this.waiting.delete(id);
      result.catch(() => void 0);
      throw error;
    }
    return result;
  }
  fail() {
    for (const waiter of this.waiting.values()) waiter.reject(new Error("Speech recognition stopped."));
    this.waiting.clear();
  }
  stop() {
    const process = this.process;
    this.process = null;
    this.generation += 1;
    this.abandon();
    this.fail();
    void process?.kill().catch(() => void 0);
  }
};
var Speaker = class {
  constructor(host, settings) {
    this.host = host;
    this.settings = settings;
  }
  current = null;
  queue = Promise.resolve();
  queued = 0;
  generation = 0;
  onIdle = () => {
  };
  get speaking() {
    return this.queued > 0;
  }
  speak(text3) {
    const settings = this.settings();
    if (!settings.speak) return;
    const clean2 = text3.replace(/^[\s-]+/, "").trim();
    if (!clean2) return;
    this.queued += 1;
    const generation = this.generation;
    this.queue = this.queue.then(() => generation === this.generation ? this.say(clean2, settings) : void 0).catch(() => void 0).finally(() => {
      if (generation === this.generation) this.done();
    });
  }
  async say(text3, settings) {
    if (this.host.spawn) {
      try {
        const args = settings.voice ? ["-v", settings.voice, text3] : [text3];
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
    await new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text3);
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      speechSynthesis.speak(utterance);
    });
  }
  done() {
    if (this.queued === 0) return;
    this.queued -= 1;
    if (this.queued === 0) this.onIdle();
  }
  stop() {
    const was = this.queued > 0;
    this.queued = 0;
    this.generation += 1;
    this.queue = Promise.resolve();
    void this.current?.kill();
    this.current = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    if (was) this.onIdle();
  }
};
var MAX_SECONDS = 120;
var PREROLL_SECONDS = 0.6;
var IDLE_RELEASE_MS = 10 * 6e4;
var Recorder = class {
  stream = null;
  context = null;
  node = null;
  opening = null;
  deviceId = "";
  capturing = false;
  chunks = [];
  samples = 0;
  preroll = [];
  prerollSamples = 0;
  idleTimer = null;
  onLevel = () => {
  };
  tap = null;
  /** The microphone closed while hands-free was streaming from it. */
  onLost = () => {
  };
  tapped = [];
  tappedSamples = 0;
  level = 0;
  get active() {
    return this.capturing;
  }
  get open() {
    return this.stream !== null;
  }
  async warm(deviceId) {
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
  async openStream(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not available here.");
    const audio = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...deviceId ? { deviceId: { exact: deviceId } } : {}
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (this.deviceId !== deviceId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const Context = window.AudioContext ?? window.webkitAudioContext;
    const context = new Context();
    const source = context.createMediaStreamSource(stream);
    const node2 = context.createScriptProcessor(2048, 1, 1);
    node2.onaudioprocess = (event) => {
      const input = new Float32Array(event.inputBuffer.getChannelData(0));
      if (this.tap) this.feedTap(resample(input, context.sampleRate, TARGET_RATE));
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
          this.prerollSamples -= this.preroll.shift().length;
        }
      }
    };
    source.connect(node2);
    node2.connect(context.destination);
    this.stream = stream;
    this.context = context;
    this.node = node2;
    if (context.state === "suspended") await context.resume();
    stream.getTracks().forEach(
      (track) => track.addEventListener("ended", () => {
        if (this.stream !== stream) return;
        const tapped = this.tap !== null;
        this.release();
        if (tapped) this.onLost();
      })
    );
    this.armIdle();
  }
  /** Streams 16 kHz audio in 100 ms frames while set, and keeps the microphone open. */
  async listen(tap, deviceId = "") {
    this.tap = tap;
    this.tapped = [];
    this.tappedSamples = 0;
    if (tap) await this.warm(deviceId);
    else this.armIdle();
  }
  feedTap(pcm) {
    this.tapped.push(pcm);
    this.tappedSamples += pcm.length;
    if (this.tappedSamples < TAP_SAMPLES) return;
    const frame = new Float32Array(this.tappedSamples);
    let at = 0;
    for (const chunk2 of this.tapped) {
      frame.set(chunk2, at);
      at += chunk2.length;
    }
    this.tapped = [];
    this.tappedSamples = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i += 16) peak = Math.max(peak, Math.abs(frame[i]));
    this.level = peak;
    this.tap?.(frame);
  }
  armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.capturing && !this.tap) this.release();
    }, IDLE_RELEASE_MS);
  }
  async start(onLevel, deviceId = "") {
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
  async stop() {
    const context = this.context;
    if (!context || !this.capturing) return null;
    this.capturing = false;
    this.level = 0;
    this.armIdle();
    const rate = context.sampleRate;
    const merged = new Float32Array(this.samples);
    let at = 0;
    for (const chunk2 of this.chunks) {
      const take = Math.min(chunk2.length, merged.length - at);
      merged.set(chunk2.subarray(0, take), at);
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
  cancel() {
    this.capturing = false;
    this.chunks = [];
    this.samples = 0;
  }
  release() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.capturing = false;
    this.tap = null;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => void 0);
    this.stream = null;
    this.context = null;
    this.node = null;
    this.chunks = [];
    this.preroll = [];
    this.prerollSamples = 0;
  }
};
async function listMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications").map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}
function resample(input, from, to) {
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
function wav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text3 = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text3(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text3(8, "WAVE");
  text3(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text3(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return new Uint8Array(buffer);
}
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
}

// src/match.ts
var ONES = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19
};
var TENS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
};
function digits(text3) {
  const words2 = text3.split(/\s+/);
  const out = [];
  for (let i = 0; i < words2.length; i += 1) {
    const word = words2[i];
    const tens = TENS[word];
    if (tens !== void 0) {
      const next = ONES[words2[i + 1] ?? ""];
      if (next !== void 0 && next < 10) {
        out.push(String(tens + next));
        i += 1;
        continue;
      }
      out.push(String(tens));
      continue;
    }
    const ones = ONES[word];
    out.push(ones === void 0 ? word : String(ones));
  }
  return out.join(" ");
}
function canon(text3) {
  return digits(text3.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim()).replace(/[^a-z0-9]+/g, "").replace(/(.)\1+/g, "$1");
}
function distance(a, b) {
  if (a === b) return 0;
  let previous2 = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        previous2[j] + 1,
        row[j - 1] + 1,
        previous2[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous2 = row;
  }
  return previous2[b.length];
}
function tolerance(name) {
  if (name.length <= 3) return 0;
  if (name.length <= 6) return 1;
  return 2;
}
function score(rawName, phrase) {
  const name = canon(rawName);
  const spoken2 = canon(phrase);
  if (!name || !spoken2) return null;
  if (spoken2 === name) return 0;
  if (spoken2.includes(name)) return 1;
  const allowed = tolerance(name);
  if (allowed === 0) return null;
  let best = Infinity;
  for (let start = 0; start < spoken2.length; start += 1) {
    for (const width of [name.length - 1, name.length, name.length + 1]) {
      if (width <= 0 || start + width > spoken2.length) continue;
      best = Math.min(best, distance(spoken2.slice(start, start + width), name));
    }
  }
  return best <= allowed ? 2 + best : null;
}
var CLASS = {
  b: "b",
  p: "b",
  v: "f",
  f: "f",
  d: "t",
  t: "t",
  g: "k",
  k: "k",
  c: "k",
  q: "k",
  s: "s",
  z: "s",
  x: "s",
  m: "n",
  n: "n",
  l: "l",
  r: "r",
  j: "j",
  w: "w"
};
function fold(text3) {
  return canon(text3).split("").map((ch) => /[0-9]/.test(ch) ? ch : CLASS[ch] ?? "").join("").replace(/(.)\1+/g, "$1");
}
function variants(rawName) {
  const words2 = rawName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return [...new Set(words2.filter((word) => word.length > 2))];
}
function scoreName(rawName, phrase) {
  const direct = score(rawName, phrase);
  if (direct !== null) return direct;
  for (const variant of variants(rawName)) {
    const hit = score(variant, phrase);
    if (hit !== null) return 5 + hit;
  }
  return null;
}
function scorePerson(rawName, phrase) {
  const strict = scoreName(rawName, phrase);
  if (strict !== null) return strict;
  const spoken2 = fold(phrase);
  if (!spoken2) return null;
  for (const candidate of [rawName, ...variants(rawName)]) {
    const name = fold(candidate);
    if (name.length < 3) continue;
    if (spoken2.includes(name)) return 10;
    const allowed = tolerance(name);
    for (let start = 0; start + name.length <= spoken2.length + 1; start += 1) {
      for (const width of [name.length - 1, name.length, name.length + 1]) {
        if (width <= 0 || start + width > spoken2.length) continue;
        if (distance(spoken2.slice(start, start + width), name) <= allowed) return 12;
      }
    }
  }
  return null;
}
function pick(items, nameOf, scorer, phrases) {
  for (const phrase of phrases) {
    if (!phrase?.trim()) continue;
    let winner = null;
    let winning = Infinity;
    for (const item of items) {
      const result = scorer(nameOf(item), phrase);
      if (result === null) continue;
      const better = result < winning || result === winning && canon(nameOf(item)).length > canon(winner ? nameOf(winner) : "").length;
      if (better) {
        winning = result;
        winner = item;
      }
    }
    if (winner) return winner;
  }
  return null;
}
function bestMatch(items, nameOf, ...phrases) {
  return pick(items, nameOf, score, phrases);
}
function bestPerson(items, nameOf, spoken2, transcript) {
  return pick(items, nameOf, scorePerson, [spoken2]) ?? pick(items, nameOf, score, [transcript]);
}
var BEFORE_CHANNEL = /((?:\S+\s+){0,3}\S+)\s+channels?\b/gi;
var AFTER_CHANNEL = /\bchannels?\s+((?:\S+\s+){0,2}\S+)/gi;
var CUE = /\b(?:in|on|to|into|from)\s+(?:the\s+)?((?:\S+\s+){0,3}\S+)/gi;
function hits(pattern, text3) {
  const found = [];
  pattern.lastIndex = 0;
  let hit = pattern.exec(text3);
  while (hit) {
    if (hit[1]?.trim()) found.push(hit[1].trim());
    hit = pattern.exec(text3);
  }
  return found;
}
function channelPhrases(text3) {
  const explicit = [...hits(BEFORE_CHANNEL, text3), ...hits(AFTER_CHANNEL, text3)];
  if (explicit.length > 0) return explicit;
  const loose = hits(CUE, text3);
  return loose.length > 0 ? loose : [text3];
}
function matchChannel(channels, spoken2, transcript) {
  return bestMatch(channels, (c) => c.name, spoken2, ...channelPhrases(transcript));
}

// src/intent.ts
var ROUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["post", "status", "inbox", "todo", "unknown"],
      description: "post when the speaker is assigning work or sending a message, status when they are asking about work in a channel, inbox when they ask about their inbox, unreads, notifications or what is waiting on them, todo when they add, assign, start, finish, reopen or list items on a channel's todo list."
    },
    todo_op: {
      type: "string",
      enum: ["add", "start", "done", "reopen", "assign", "list"],
      description: "For action todo: add a new todo, start one (in progress), mark one done, reopen one, assign an existing one to someone, or list them. Use add for anything else."
    },
    channel: {
      type: ["string", "null"],
      description: "Exact channel name from the provided list, or null if none was named."
    },
    recipient: {
      type: ["string", "null"],
      description: "The agent or person the speaker told to do the work, as they said it, or null if they addressed nobody. Drop words like bot and agent."
    },
    continues_previous: {
      type: "boolean",
      description: 'True when the speaker is building on the previous exchange rather than starting something new, for example "act on that".'
    },
    thread: {
      type: "string",
      enum: ["new", "existing"],
      description: 'existing when the speaker is replying inside a thread that is already in scope, for example "reply in that thread". new otherwise.'
    },
    thread_ref: {
      type: ["integer", "null"],
      description: "The number of the scope thread the speaker means, from the numbered list of threads in scope, or null when they named none."
    },
    thread_hint: {
      type: ["string", "null"],
      description: 'How the speaker described the thread when they described it by subject instead of by number, in their own words and nothing else. From "the thread about the login bug in ops" it is "login bug". Null when they described no thread. "the latest thread" and "the newest one" are not descriptions, they are null.'
    },
    new_thread: {
      type: "boolean",
      description: 'True only when the speaker explicitly asked for a new thread or a new topic, for example "start a new thread about X". False for everything else, including a sentence that names no thread at all.'
    },
    instruction: {
      type: "string",
      description: `The message to post, as a direct instruction addressed to nobody. Keep the speaker's own wording and their domain terms verbatim. Strip the routing framing: the thread or channel the speaker picked out, and any "tell NAME", "tell NAME to" or "ask NAME to" wrapper. The recipient is tagged separately, so naming them here says it twice. From "in the thread about the login bug in ops tell build-bot that the fix is live" the instruction is "The fix is live." Empty for status actions. For todo actions it is the todo itself, short and imperative, without the assignee: from "add a todo in ops for build-bot to rerun the deploy" it is "Rerun the deploy". For a todo that already exists it is how the speaker described it.`
    },
    filter: {
      type: "string",
      enum: ["working", "stalled", "done", "needs-input", "all"],
      description: "Which tracked threads the speaker asked about. Use all when unspecified."
    },
    spoken_confirmation: {
      type: "string",
      description: "What is read back before sending. Name the channel and the gist in at most 12 words. No pleasantries."
    }
  },
  required: [
    "action",
    "todo_op",
    "channel",
    "recipient",
    "continues_previous",
    "thread",
    "thread_ref",
    "thread_hint",
    "new_thread",
    "instruction",
    "filter",
    "spoken_confirmation"
  ]
};
var WORDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    instruction: ROUTE_SCHEMA.properties.instruction,
    thread_hint: ROUTE_SCHEMA.properties.thread_hint,
    spoken_confirmation: ROUTE_SCHEMA.properties.spoken_confirmation
  },
  required: ["instruction", "thread_hint", "spoken_confirmation"]
};
var ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: {
      type: "string",
      description: "The spoken answer in at most two sentences and under 40 words. Answer only what was asked, lead with it, and leave out background, process and caveats. No markdown, no lists, no links, no event ids. Name who said it. Say plainly if the messages do not answer the question."
    },
    thread: {
      type: ["integer", "null"],
      description: `The number of the thread the answer came from, or null if the answer draws on several threads or none. The speaker's next sentence may be "reply in that thread", so this has to be the thread being talked about.`
    }
  },
  required: ["answer", "thread"]
};
var PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thread: {
      type: ["integer", "null"],
      description: "The number of the thread the speaker meant, or null when none of them is what they described. Judge it on subject, not on wording: they are working from memory and will not repeat a thread's opening line."
    }
  },
  required: ["thread"]
};
function clean(value) {
  const text3 = value?.trim();
  if (!text3) return null;
  return ["null", "none", "unknown", "n/a"].includes(text3.toLowerCase()) ? null : text3;
}
function firstJson(text3) {
  const trimmed = text3.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}
async function ask(llm, name, schema, messages, maxTokens) {
  const base = {
    model: llm.model,
    max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false },
    messages
  };
  const guided = {
    ...base,
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }
  };
  const tooled = {
    ...base,
    tool_choice: { type: "function", function: { name } },
    tools: [{ type: "function", function: { name, parameters: schema } }]
  };
  let failure = "the model did not return a decision";
  for (const body of [guided, guided, tooled]) {
    let parsed;
    try {
      parsed = JSON.parse(await llm.post(body));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (parsed?.error) {
      failure = parsed.error.message ?? String(parsed.error);
      continue;
    }
    const message2 = parsed?.choices?.[0]?.message;
    const text3 = message2?.tool_calls?.[0]?.function?.arguments ?? message2?.content ?? "";
    const value = firstJson(String(text3));
    if (value) return value;
  }
  throw new Error(failure);
}
var history = (turns) => turns.map((turn) => ({ role: turn.role === "you" ? "user" : "assistant", content: turn.text }));
var DOMAIN_TERMS = [
  "The speaker uses domain terms: hostnames, repo names, agent names, branch names.",
  "Copy them through exactly as transcribed. Never expand an abbreviation and never",
  "replace a word with a more common one you think they meant.",
  "Earlier turns of this session are included. Use them to resolve references",
  'like "that", "them" or "the previous message", and write an instruction that',
  "stands on its own without them."
];
async function wordsOnly(llm, transcript, turns) {
  const system = [
    "You write the message body for a spoken Buzz command.",
    "Where the message goes has already been decided, so your only job is the words.",
    ...DOMAIN_TERMS,
    "The instruction is the message body and nothing else. Leave out which",
    "thread and which channel they picked, and leave out the recipient's name:",
    "they are tagged separately and the name would appear twice.",
    "When they pick a thread out by what it is about, put that description in",
    "thread_hint in their own words. Null when they described no thread.",
    "Answer with one JSON object and nothing else."
  ].join("\n");
  return ask(
    llm,
    "words",
    WORDS_SCHEMA,
    [{ role: "system", content: system }, ...history(turns), { role: "user", content: transcript }],
    512
  );
}
var TODO_OPS = ["add", "start", "done", "reopen", "assign", "list"];
var NO_CHANNEL = "no_channel";
var NOBODY = "nobody";
var NO_THREAD = "none";
var MAX_OPTIONS = 250;
function choiceOf(answers, id) {
  const answer = answers[id];
  return answer?.type === "choice" ? answer.choice : null;
}
function yes(answers, id) {
  const answer = answers[id];
  return answer?.type === "yes_no" && answer.probability > 0.5;
}
function short(text3, fallback) {
  const flat = (text3 ?? "").replace(/\s+/g, " ").trim();
  return (flat || fallback).slice(0, 200);
}
async function decideRoute(decide, community, transcript, channels, people, scope, previous2) {
  const channelOptions = {};
  for (const channel2 of channels.slice(0, MAX_OPTIONS - 1)) {
    channelOptions[channel2.name] = short(channel2.description, `The ${channel2.name} channel.`);
  }
  channelOptions[NO_CHANNEL] = "The sentence names no channel.";
  const questions = {
    action: {
      type: "choice",
      instructions: "Classify the speaker's request.",
      options: {
        post: "The speaker is issuing an instruction or sending a message to someone else.",
        status: "The speaker is asking for an update about a named project, channel or thread.",
        inbox: "The speaker is asking about their own unread messages or notifications.",
        todo: "The speaker is adding, assigning, starting, finishing, reopening or listing items on a channel's todo list."
      }
    },
    todo_op: {
      type: "choice",
      instructions: "If the speaker is working with a todo list, what are they doing to it?",
      options: {
        add: "Adding a new todo.",
        start: "Marking an existing todo as in progress.",
        done: "Marking an existing todo as done.",
        reopen: "Reopening a todo that was done.",
        assign: "Assigning an existing todo to someone.",
        list: "Asking what is on the list."
      }
    },
    channel: {
      type: "choice",
      instructions: "Which chat channel did the speaker name? The sentence came from a speech recogniser, so names arrive mangled: letters are spelled out and digits come back as words. Match by sound, not by spelling.",
      options: channelOptions
    },
    new_thread: {
      type: "yes_no",
      instructions: "The speaker explicitly asked for a new thread, a new topic or a separate thread."
    },
    filter: {
      type: "choice",
      instructions: "Which tracked threads did the speaker ask about?",
      options: {
        working: "Only work still in progress.",
        stalled: "Only work that is stuck.",
        done: "Only finished work.",
        "needs-input": "Only work waiting on the speaker.",
        all: "They did not narrow it down."
      }
    }
  };
  if (people.length) {
    const personOptions = {};
    for (const person of people.slice(0, MAX_OPTIONS - 1)) personOptions[person] = `The member named ${person}.`;
    personOptions[NOBODY] = "The speaker addressed no one in particular.";
    questions.recipient = {
      type: "choice",
      instructions: "Which agent or person did the speaker tell to do the work? Agents are often named after the machines they run on, so a recipient can sound like a channel. A channel name is never a recipient.",
      options: personOptions
    };
  }
  if (scope.threads.length) {
    const threadOptions = {};
    scope.threads.forEach((thread2, index2) => {
      threadOptions[String(index2 + 1)] = short(thread2.label, `Thread ${index2 + 1}.`);
    });
    threadOptions[NO_THREAD] = "They described no particular thread.";
    questions.thread = {
      type: "choice",
      instructions: "The speaker may have picked out one of the threads already in scope, by number or by what it is about. Which one?",
      options: threadOptions
    };
  }
  if (previous2) {
    questions.continues = {
      type: "yes_no",
      instructions: "The speaker is building on the previous exchange rather than starting something new."
    };
  }
  const state = previous2 ? `Previous exchange: ${previous2}

Spoken now: ${transcript}` : `Spoken now: ${transcript}`;
  const result = await decide({ state, questions, timeoutMs: 15e3, community });
  if (result.outcome !== "answered") return null;
  const answers = result.answers;
  const action = choiceOf(answers, "action");
  const todoOp = choiceOf(answers, "todo_op");
  const channel = choiceOf(answers, "channel");
  const recipient = choiceOf(answers, "recipient");
  const thread = choiceOf(answers, "thread");
  const filter = choiceOf(answers, "filter");
  const ref = thread && thread !== NO_THREAD ? Number(thread) : NaN;
  return {
    action: action === "status" || action === "inbox" || action === "todo" ? action : "post",
    todo_op: TODO_OPS.includes(todoOp) ? todoOp : "add",
    channel: channel && channel !== NO_CHANNEL ? channel : null,
    recipient: recipient && recipient !== NOBODY ? recipient : null,
    thread_ref: Number.isInteger(ref) && ref > 0 && ref <= scope.threads.length ? ref : null,
    new_thread: yes(answers, "new_thread"),
    continues_previous: yes(answers, "continues"),
    filter: filter ?? "all"
  };
}
function scopeLines(scope) {
  if (!scope.channel || scope.threads.length === 0) return [];
  const lines = [
    "",
    "In scope right now, from the last channel the speaker read or posted to.",
    `Channel: ${scope.channel.name}`,
    "Threads, newest last:",
    ...scope.threads.map(
      (thread, index2) => `  ${index2 + 1}. ${thread.label}${thread.who.length ? ` (${thread.who.join(", ")})` : ""}`
    )
  ];
  if (scope.focus) {
    const index2 = scope.threads.findIndex((t) => t.rootId === scope.focus?.rootId);
    if (index2 >= 0) {
      lines.push(
        `Thread ${index2 + 1} is the one just read back or posted to. "that thread" and "in there" mean it.`
      );
    }
  }
  lines.push(
    "Set thread_ref to the number of the thread the speaker means and thread to existing.",
    "A sentence that starts something unrelated is thread new and thread_ref null."
  );
  return lines;
}
async function parseIntent(options) {
  const { llm, decide, community, transcript, channels, people, scope, turns } = options;
  if (decide) {
    const words2 = llm ? wordsOnly(llm, transcript, turns).catch(() => ({})) : null;
    const routed = await decideRoute(
      decide,
      community,
      transcript,
      channels,
      people,
      scope,
      turns.at(-1)?.text ?? null
    ).catch(() => null);
    if (routed) {
      const said = words2 ? await words2 : {};
      const recipient2 = clean(routed.recipient);
      return {
        action: routed.action,
        todo_op: routed.todo_op,
        channel: routed.channel,
        recipient: recipient2,
        continues_previous: routed.continues_previous,
        thread: routed.thread_ref !== null ? "existing" : "new",
        thread_ref: routed.thread_ref,
        thread_hint: describedThread(clean(said.thread_hint)),
        new_thread: routed.new_thread && WANTS_NEW.test(transcript),
        instruction: stripRouting(said.instruction || transcript, recipient2),
        filter: routed.filter,
        spoken_confirmation: said.spoken_confirmation ?? ""
      };
    }
    if (words2) await words2;
  }
  if (!llm) throw new Error("Routing needs a Decisions provider or an LLM. Set one up in Settings.");
  const list2 = channels.map((c) => `${c.name}: ${c.description || "no description"}`).join("\n");
  const system = [
    "You turn a spoken sentence into a Buzz routing decision.",
    "The speaker owns these channels and the agents in them.",
    "The sentence comes from a speech recogniser, so channel names arrive mangled:",
    'letters are spelled out and digits come back as words, for example "abc12" is',
    'heard as "a b c twelve". Match the channel by sound and meaning, not by exact',
    "words, and always answer with a name from the list.",
    ...DOMAIN_TERMS,
    "When the speaker is telling an agent to do something, action is post.",
    "Agents are often named after the machines they run on, so a recipient can sound",
    "like a channel. The channel is where they said to go, never who they addressed.",
    "A channel name is never a recipient.",
    "The speaker works in threads. A sentence goes into an existing thread unless they",
    "explicitly ask for a new one, so new_thread is false almost always.",
    "When they pick a thread out by what it is about rather than by number, put",
    "that description in thread_hint. It is looked up against the real threads",
    "afterwards, so copy their words and do not guess a number.",
    "The instruction is the message body and nothing else. Leave out which",
    "thread and which channel they picked, and leave out the recipient's name:",
    "they are tagged separately and the name would appear twice.",
    "When they are asking how work is going, action is status.",
    'Each channel has a todo list. "add a todo", "put X on the list", "mark the X todo',
    'done" and "what is on the todo list" are action todo. In "a todo for NAME" or',
    '"assign it to NAME", NAME is the recipient.',
    "The inbox is what is unread and waiting on the speaker across every channel.",
    '"my inbox", "unreads", "notifications", "what is waiting on me" and',
    '"anything for me" are action inbox with channel null. Inbox is never a',
    "channel name, whatever the channels are called.",
    "Answer with one JSON object and nothing else.",
    "Channels:",
    list2,
    ...people.length ? [
      "",
      "The people and agents in these channels. Their names arrive mangled too,",
      "so map what was said onto one of these and answer with it verbatim:",
      people.join(", ")
    ] : [],
    ...scopeLines(scope)
  ].join("\n");
  const input = await ask(
    llm,
    "route",
    ROUTE_SCHEMA,
    [{ role: "system", content: system }, ...history(turns), { role: "user", content: transcript }],
    768
  );
  const ref = typeof input.thread_ref === "number" && input.thread_ref > 0 ? input.thread_ref : null;
  const named = clean(input.recipient);
  const recipient = named && channels.some((c) => canon(c.name) === canon(named)) ? null : named;
  return {
    action: input.action ?? "unknown",
    todo_op: TODO_OPS.includes(input.todo_op) ? input.todo_op : "add",
    channel: clean(input.channel),
    recipient,
    continues_previous: input.continues_previous ?? false,
    thread: input.thread === "existing" || ref !== null ? "existing" : "new",
    thread_ref: ref,
    thread_hint: describedThread(clean(input.thread_hint)),
    new_thread: input.new_thread === true && WANTS_NEW.test(transcript),
    instruction: stripRouting(input.instruction ?? "", recipient),
    filter: input.filter ?? "all",
    spoken_confirmation: input.spoken_confirmation ?? ""
  };
}
var WANTS_NEW = /\bnew\s+(?:thread|topic|conversation)\b|\bthread\s+(?:for|about)\s+(?:a\s+)?new\b|\bstart\s+(?:a|another)\s+thread\b|\bseparate\s+thread\b|\bown\s+thread\b|\btop\s*level\b/i;
function describedThread(hint) {
  if (!hint) return null;
  const bare = hint.toLowerCase().replace(/^the\s+/, "").replace(/\s+(?:thread|one)$/, "").trim();
  return ["latest", "newest", "last", "recent", "most recent", "current", "same", "that", "this"].includes(bare) ? null : hint;
}
function stripRouting(instruction, recipient) {
  let text3 = instruction.trim();
  const name = recipient ? recipient.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
  const patterns = [
    /^(?:and\s+)?(?:in|on|under|to)\s+the\s+(?:existing\s+)?thread\s+(?:about|on|for|re|regarding|where|discussing)\b[^,.]*[,.]?\s*/i,
    /^(?:and\s+)?(?:in|on)\s+(?:that|this|the\s+(?:latest|newest|last|same|current))\s+thread\b[,.]?\s*/i,
    /^(?:and\s+)?in\s+(?:the\s+)?[\w.-]+\s+channel\b[,.]?\s*/i,
    ...name ? [
      new RegExp(`^(?:and\\s+)?(?:please\\s+)?(?:tell|ask|let)\\s+@?${name}\\s+(?:that|to|know\\s+that|know)?\\s*`, "i"),
      new RegExp(`^@?${name}[,:]?\\s+`, "i")
    ] : [],
    /^(?:and\s+)?(?:please\s+)?(?:tell|ask|let)\s+(?:them|him|her|the\s+agent)\s+(?:that|to|know\s+that|know)?\s*/i,
    /^(?:and\s+)?(?:please\s+)?(?:tell|ask)\s+(?=(?:that|the|this|it|we|i|he|she|they|there)\b)(?:that\s+)?/i,
    /^(?:start|open|post)\s+a\s+new\s+thread\s+(?:about|on|for|re)\s+/i
  ];
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text3;
    for (const pattern of patterns) text3 = text3.replace(pattern, "").trim();
    text3 = stripSpokenName(text3, recipient);
    if (text3 === before) break;
  }
  if (!text3) return instruction.trim();
  return text3.charAt(0).toUpperCase() + text3.slice(1);
}
function stripSpokenName(text3, recipient) {
  if (!recipient) return text3;
  const lead = /^(?:and\s+)?(?:please\s+)?(?:tell|ask|let)\s+/i.exec(text3);
  if (!lead) return text3;
  const words2 = text3.slice(lead[0].length).split(/\s+/);
  const wanted = canon(recipient);
  for (let take = Math.min(5, words2.length); take >= 1; take -= 1) {
    if (canon(words2.slice(0, take).join(" ")) !== wanted) continue;
    return words2.slice(take).join(" ").replace(/^(?:that|to|know\s+that|know)\s+/i, "").trim();
  }
  return text3;
}
async function pickThread(options) {
  const { llm, decide, community, channelName, hint, transcript, labels } = options;
  if (labels.length === 0) return null;
  if (decide) {
    const opts = {};
    labels.forEach((label, index2) => {
      opts[String(index2 + 1)] = short(label, `Thread ${index2 + 1}.`);
    });
    opts[NO_THREAD] = "They described no particular thread.";
    const result = await decide({
      state: `Channel: ${channelName}
Spoken: ${transcript}${hint ? `
They called it: ${hint}` : ""}`,
      questions: {
        thread: {
          type: "choice",
          instructions: "The speaker named a thread by what it is about, not by its opening line. Which of these do they mean? They are working from memory and will not repeat the thread's own wording.",
          options: opts
        }
      },
      timeoutMs: 15e3,
      community
    }).catch(() => null);
    if (result?.outcome === "answered") {
      const picked = choiceOf(result.answers, "thread");
      const ref2 = picked && picked !== NO_THREAD ? Number(picked) : NaN;
      return Number.isInteger(ref2) && ref2 > 0 && ref2 <= labels.length ? ref2 : null;
    }
  }
  if (!llm) return null;
  const input = await ask(
    llm,
    "pick",
    PICK_SCHEMA,
    [
      {
        role: "system",
        content: [
          `The speaker named a thread in the ${channelName} channel. Work out which one.`,
          "Threads, newest last, shown by their opening line:",
          ...labels.map((label, index2) => `  ${index2 + 1}. ${label}`),
          "Answer with one JSON object and nothing else."
        ].join("\n")
      },
      { role: "user", content: hint ? `${transcript}

They called it: ${hint}` : transcript }
    ],
    200
  );
  const ref = typeof input.thread === "number" && input.thread > 0 ? input.thread : null;
  return ref !== null && ref <= labels.length ? ref : null;
}
async function summarizeChannel(llm, channelName, question, blocks) {
  return summarize(
    llm,
    [
      "You read a Buzz channel back to its owner out loud.",
      "The messages are grouped into numbered threads, oldest thread first,",
      "and each thread is oldest message first.",
      `Channel: ${channelName}`
    ],
    question,
    blocks
  );
}
async function summarizeInbox(llm, question, blocks) {
  return summarize(
    llm,
    [
      "You read the speaker's Buzz inbox back to them out loud.",
      "Each numbered item is an unread thread that mentions them, oldest first,",
      "with its channel and the people in it.",
      "Open with the count, then the single item that most needs them.",
      "Do not list them all.",
      "Set thread to the number of the item you named, never null.",
      "In the spoken answer name that item by its channel and who is waiting,",
      "never by its number."
    ],
    question,
    blocks
  );
}
async function summarize(llm, preamble, question, blocks) {
  const input = await ask(
    llm,
    "answer",
    ANSWER_SCHEMA,
    [
      {
        role: "system",
        content: [
          ...preamble,
          "Keep it to two sentences at most. They ask for detail when they want it.",
          "Answer with one JSON object and nothing else.",
          blocks.join("\n\n")
        ].join("\n")
      },
      { role: "user", content: question }
    ],
    700
  );
  const answer = String(input.answer ?? "");
  if (!answer.trim()) throw new Error("the model returned no summary");
  const thread = typeof input.thread === "number" && input.thread > 0 ? input.thread : null;
  return { answer: answer.replace(/\s+/g, " ").trim(), thread };
}

// node_modules/mdast-util-to-string/lib/index.js
var emptyOptions = {};
function toString(value, options) {
  const settings = options || emptyOptions;
  const includeImageAlt = typeof settings.includeImageAlt === "boolean" ? settings.includeImageAlt : true;
  const includeHtml = typeof settings.includeHtml === "boolean" ? settings.includeHtml : true;
  return one(value, includeImageAlt, includeHtml);
}
function one(value, includeImageAlt, includeHtml) {
  if (node(value)) {
    if ("value" in value) {
      return value.type === "html" && !includeHtml ? "" : value.value;
    }
    if (includeImageAlt && "alt" in value && value.alt) {
      return value.alt;
    }
    if ("children" in value) {
      return all(value.children, includeImageAlt, includeHtml);
    }
  }
  if (Array.isArray(value)) {
    return all(value, includeImageAlt, includeHtml);
  }
  return "";
}
function all(values, includeImageAlt, includeHtml) {
  const result = [];
  let index2 = -1;
  while (++index2 < values.length) {
    result[index2] = one(values[index2], includeImageAlt, includeHtml);
  }
  return result.join("");
}
function node(value) {
  return Boolean(value && typeof value === "object");
}

// node_modules/decode-named-character-reference/index.dom.js
var element = document.createElement("i");
function decodeNamedCharacterReference(value) {
  const characterReference2 = "&" + value + ";";
  element.innerHTML = characterReference2;
  const character = element.textContent;
  if (character.charCodeAt(character.length - 1) === 59 && value !== "semi") {
    return false;
  }
  return character === characterReference2 ? false : character;
}

// node_modules/micromark-util-chunked/index.js
function splice(list2, start, remove, items) {
  const end = list2.length;
  let chunkStart = 0;
  let parameters;
  if (start < 0) {
    start = -start > end ? 0 : end + start;
  } else {
    start = start > end ? end : start;
  }
  remove = remove > 0 ? remove : 0;
  if (items.length < 1e4) {
    parameters = Array.from(items);
    parameters.unshift(start, remove);
    list2.splice(...parameters);
  } else {
    if (remove) list2.splice(start, remove);
    while (chunkStart < items.length) {
      parameters = items.slice(chunkStart, chunkStart + 1e4);
      parameters.unshift(start, 0);
      list2.splice(...parameters);
      chunkStart += 1e4;
      start += 1e4;
    }
  }
}
function push(list2, items) {
  if (list2.length > 0) {
    splice(list2, list2.length, 0, items);
    return list2;
  }
  return items;
}

// node_modules/micromark-util-combine-extensions/index.js
var hasOwnProperty = {}.hasOwnProperty;
function combineExtensions(extensions) {
  const all2 = {};
  let index2 = -1;
  while (++index2 < extensions.length) {
    syntaxExtension(all2, extensions[index2]);
  }
  return all2;
}
function syntaxExtension(all2, extension2) {
  let hook;
  for (hook in extension2) {
    const maybe = hasOwnProperty.call(all2, hook) ? all2[hook] : void 0;
    const left = maybe || (all2[hook] = {});
    const right = extension2[hook];
    let code;
    if (right) {
      for (code in right) {
        if (!hasOwnProperty.call(left, code)) left[code] = [];
        const value = right[code];
        constructs(
          // @ts-expect-error Looks like a list.
          left[code],
          Array.isArray(value) ? value : value ? [value] : []
        );
      }
    }
  }
}
function constructs(existing, list2) {
  let index2 = -1;
  const before = [];
  while (++index2 < list2.length) {
    ;
    (list2[index2].add === "after" ? existing : before).push(list2[index2]);
  }
  splice(existing, 0, 0, before);
}

// node_modules/micromark-util-decode-numeric-character-reference/index.js
function decodeNumericCharacterReference(value, base) {
  const code = Number.parseInt(value, base);
  if (
    // C0 except for HT, LF, FF, CR, space.
    code < 9 || code === 11 || code > 13 && code < 32 || // Control character (DEL) of C0, and C1 controls.
    code > 126 && code < 160 || // Lone high surrogates and low surrogates.
    code > 55295 && code < 57344 || // Noncharacters.
    code > 64975 && code < 65008 || /* eslint-disable no-bitwise */
    (code & 65535) === 65535 || (code & 65535) === 65534 || /* eslint-enable no-bitwise */
    // Out of range
    code > 1114111
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(code);
}

// node_modules/micromark-util-normalize-identifier/index.js
function normalizeIdentifier(value) {
  return value.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();
}

// node_modules/micromark-util-character/index.js
var asciiAlpha = regexCheck(/[A-Za-z]/);
var asciiAlphanumeric = regexCheck(/[\dA-Za-z]/);
var asciiAtext = regexCheck(/[#-'*+\--9=?A-Z^-~]/);
function asciiControl(code) {
  return (
    // Special whitespace codes (which have negative values), C0 and Control
    // character DEL
    code !== null && (code < 32 || code === 127)
  );
}
var asciiDigit = regexCheck(/\d/);
var asciiHexDigit = regexCheck(/[\dA-Fa-f]/);
var asciiPunctuation = regexCheck(/[!-/:-@[-`{-~]/);
function markdownLineEnding(code) {
  return code !== null && code < -2;
}
function markdownLineEndingOrSpace(code) {
  return code !== null && (code < 0 || code === 32);
}
function markdownSpace(code) {
  return code === -2 || code === -1 || code === 32;
}
var unicodePunctuation = regexCheck(/\p{P}|\p{S}/u);
var unicodeWhitespace = regexCheck(/\s/);
function regexCheck(regex) {
  return check;
  function check(code) {
    return code !== null && code > -1 && regex.test(String.fromCharCode(code));
  }
}

// node_modules/micromark-factory-space/index.js
function factorySpace(effects, ok, type, max) {
  const limit = max ? max - 1 : Infinity;
  let size = 0;
  return start;
  function start(code) {
    if (markdownSpace(code)) {
      effects.enter(type);
      return prefix(code);
    }
    return ok(code);
  }
  function prefix(code) {
    if (markdownSpace(code) && size++ < limit) {
      effects.consume(code);
      return prefix;
    }
    effects.exit(type);
    return ok(code);
  }
}
function factorySpaceMinMax(effects, ok, nok, type, min, max) {
  let size = 0;
  return start;
  function start(code) {
    if (max > 0 && markdownSpace(code)) {
      effects.enter(type);
      return prefix(code);
    }
    return after(code);
  }
  function prefix(code) {
    if (markdownSpace(code) && size < max) {
      effects.consume(code);
      size++;
      return prefix;
    }
    effects.exit(type);
    return after(code);
  }
  function after(code) {
    return size >= min ? ok(code) : nok(code);
  }
}

// node_modules/micromark/lib/initialize/content.js
var content = {
  tokenize: initializeContent
};
function initializeContent(effects) {
  const contentStart = effects.attempt(this.parser.constructs.contentInitial, afterContentStartConstruct, paragraphInitial);
  let previous2;
  return contentStart;
  function afterContentStartConstruct(code) {
    if (code === null) {
      effects.consume(code);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return factorySpace(effects, contentStart, "linePrefix");
  }
  function paragraphInitial(code) {
    effects.enter("paragraph");
    return lineStart(code);
  }
  function lineStart(code) {
    const token = effects.enter("chunkText", {
      contentType: "text",
      previous: previous2
    });
    if (previous2) {
      previous2.next = token;
    }
    previous2 = token;
    return data(code);
  }
  function data(code) {
    if (code === null) {
      effects.exit("chunkText");
      effects.exit("paragraph");
      effects.consume(code);
      return;
    }
    if (markdownLineEnding(code)) {
      effects.consume(code);
      effects.exit("chunkText");
      return lineStart;
    }
    effects.consume(code);
    return data;
  }
}

// node_modules/micromark-util-edit-map/index.js
var EditMap = class {
  /**
   * Create a new edit map.
   *
   * @returns
   *   New instance.
   */
  constructor() {
    this.index = /* @__PURE__ */ new Map();
    this.map = [];
  }
  /**
   * Create an edit: a remove and/or add at a certain place.
   *
   * @param {number} index
   *   Index at which to apply the edit.
   * @param {number} remove
   *   Count of items to remove at the index.
   * @param {Array<Event>} add
   *   Items to add at the index.
   * @returns {undefined}
   *   Nothing.
   */
  add(index2, remove, add) {
    addImplementation(this, index2, remove, add, false);
  }
  /**
   * Create an edit: but insert `add` before existing additions, instead of
   * after them.
   *
   * @param {number} index
   *   Index at which to apply the edit.
   * @param {number} remove
   *   Count of items to remove at the index.
   * @param {Array<Event>} add
   *   Items to add at the index.
   * @returns {undefined}
   *   Nothing.
   */
  addBefore(index2, remove, add) {
    addImplementation(this, index2, remove, add, true);
  }
  /**
   * Done, change the events.
   *
   * @param {Array<Event>} events
   *   List of events to apply the edits to.
   * @returns {undefined}
   *   Nothing.
   */
  consume(events) {
    this.map.sort(function(a, b) {
      return a[0] - b[0];
    });
    if (this.map.length === 0) {
      return;
    }
    let index2 = this.map.length;
    const vecs = [];
    while (index2 > 0) {
      index2 -= 1;
      vecs.push(events.slice(this.map[index2][0] + this.map[index2][1]), this.map[index2][2]);
      events.length = this.map[index2][0];
    }
    vecs.push(events.slice());
    events.length = 0;
    let slice = vecs.pop();
    while (slice) {
      for (const element2 of slice) {
        events.push(element2);
      }
      slice = vecs.pop();
    }
    this.map.length = 0;
    this.index.clear();
  }
};
function addImplementation(editMap, at, remove, add, before) {
  if (remove === 0 && add.length === 0) {
    return;
  }
  const existing = editMap.index.get(at);
  if (existing) {
    existing[1] += remove;
    if (before) {
      add.push(...existing[2]);
      existing[2] = add;
    } else {
      existing[2].push(...add);
    }
    return;
  }
  const change = [at, remove, add];
  editMap.map.push(change);
  editMap.index.set(at, change);
}

// node_modules/micromark/lib/initialize/document.js
var document2 = {
  tokenize: initializeDocument
};
var containerConstruct = {
  tokenize: tokenizeContainer
};
function initializeDocument(effects) {
  const self = this;
  const stack = [];
  let continued = 0;
  let childFlow;
  let childToken;
  let lineStartOffset;
  return start;
  function start(code) {
    if (continued < stack.length) {
      const item = stack[continued];
      self.containerState = item[1];
      return effects.attempt(item[0].continuation, documentContinue, checkNewContainers)(code);
    }
    return checkNewContainers(code);
  }
  function documentContinue(code) {
    continued++;
    if (self.containerState._closeFlow) {
      self.containerState._closeFlow = void 0;
      if (childFlow) {
        closeFlow();
      }
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let point3;
      while (indexBeforeFlow--) {
        if (self.events[indexBeforeFlow][0] === "exit" && self.events[indexBeforeFlow][1].type === "chunkFlow") {
          point3 = self.events[indexBeforeFlow][1].end;
          break;
        }
      }
      exitContainers(continued);
      let index2 = indexBeforeExits;
      while (index2 < self.events.length) {
        self.events[index2][1].end = {
          ...point3
        };
        index2++;
      }
      const editMap = new EditMap();
      editMap.add(indexBeforeFlow + 1, 0, self.events.slice(indexBeforeExits));
      editMap.add(indexBeforeExits, index2 - indexBeforeExits, []);
      editMap.consume(self.events);
      return checkNewContainers(code);
    }
    return start(code);
  }
  function checkNewContainers(code) {
    if (continued === stack.length) {
      if (!childFlow) {
        return documentContinued(code);
      }
      if (childFlow.currentConstruct && childFlow.currentConstruct.concrete) {
        return flowStart(code);
      }
      self.interrupt = Boolean(childFlow.currentConstruct && !childFlow._gfmTableDynamicInterruptHack);
    }
    self.containerState = {};
    return effects.check(containerConstruct, thereIsANewContainer, thereIsNoNewContainer)(code);
  }
  function thereIsANewContainer(code) {
    if (childFlow) {
      closeFlow();
    }
    exitContainers(continued);
    return documentContinued(code);
  }
  function thereIsNoNewContainer(code) {
    self.parser.lazy[self.now().line] = continued !== stack.length;
    lineStartOffset = self.now().offset;
    return flowStart(code);
  }
  function documentContinued(code) {
    self.containerState = {};
    return effects.attempt(containerConstruct, containerContinue, flowStart)(code);
  }
  function containerContinue(code) {
    continued++;
    stack.push([self.currentConstruct, self.containerState]);
    return documentContinued(code);
  }
  function flowStart(code) {
    if (code === null) {
      if (childFlow) {
        closeFlow();
      }
      exitContainers(0);
      effects.consume(code);
      return;
    }
    childFlow = childFlow || self.parser.flow(self.now());
    effects.enter("chunkFlow", {
      _tokenizer: childFlow,
      contentType: "flow",
      previous: childToken
    });
    return flowContinue(code);
  }
  function flowContinue(code) {
    if (code === null) {
      writeToChild(effects.exit("chunkFlow"), true);
      exitContainers(0);
      effects.consume(code);
      return;
    }
    if (markdownLineEnding(code)) {
      effects.consume(code);
      writeToChild(effects.exit("chunkFlow"));
      continued = 0;
      self.interrupt = void 0;
      return start;
    }
    effects.consume(code);
    return flowContinue;
  }
  function writeToChild(token, endOfFile) {
    const stream = self.sliceStream(token);
    if (endOfFile) {
      stream.push(null);
    }
    token.previous = childToken;
    if (childToken) {
      childToken.next = token;
    }
    childToken = token;
    childFlow.defineSkip(token.start);
    childFlow.write(stream);
    if (self.parser.lazy[token.start.line]) {
      let index2 = childFlow.events.length;
      while (index2--) {
        if (
          // The token starts before the line ending…
          childFlow.events[index2][1].start.offset < lineStartOffset && // …and either is not ended yet…
          (!childFlow.events[index2][1].end || // …or ends after it.
          childFlow.events[index2][1].end.offset > lineStartOffset)
        ) {
          return;
        }
      }
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let seen;
      let point3;
      while (indexBeforeFlow--) {
        if (self.events[indexBeforeFlow][0] === "exit" && self.events[indexBeforeFlow][1].type === "chunkFlow") {
          if (seen) {
            point3 = self.events[indexBeforeFlow][1].end;
            break;
          }
          seen = true;
        }
      }
      exitContainers(continued);
      index2 = indexBeforeExits;
      while (index2 < self.events.length) {
        self.events[index2][1].end = {
          ...point3
        };
        index2++;
      }
      const editMap = new EditMap();
      editMap.add(indexBeforeFlow + 1, 0, self.events.slice(indexBeforeExits));
      editMap.add(indexBeforeExits, index2 - indexBeforeExits, []);
      editMap.consume(self.events);
    }
  }
  function exitContainers(size) {
    let index2 = stack.length;
    while (index2-- > size) {
      const entry = stack[index2];
      self.containerState = entry[1];
      entry[0].exit.call(self, effects);
    }
    stack.length = size;
  }
  function closeFlow() {
    childFlow.write([null]);
    childToken = void 0;
    childFlow = void 0;
    self.containerState._closeFlow = void 0;
  }
}
function tokenizeContainer(effects, ok, nok) {
  return factorySpace(effects, effects.attempt(this.parser.constructs.document, ok, nok), "linePrefix", this.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4);
}

// node_modules/micromark-util-classify-character/index.js
function classifyCharacter(code) {
  if (code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code)) {
    return 1;
  }
  if (unicodePunctuation(code)) {
    return 2;
  }
}

// node_modules/micromark-util-resolve-all/index.js
function resolveAll(constructs2, events, context) {
  const called = [];
  let index2 = -1;
  while (++index2 < constructs2.length) {
    const resolve = constructs2[index2].resolveAll;
    if (resolve && !called.includes(resolve)) {
      events = resolve(events, context);
      called.push(resolve);
    }
  }
  return events;
}

// node_modules/micromark-core-commonmark/lib/attention.js
var attention = {
  name: "attention",
  resolveAll: resolveAllAttention,
  tokenize: tokenizeAttention
};
function resolveAllAttention(events, context) {
  let index2 = -1;
  let nextEvents;
  while (++index2 < events.length) {
    if (events[index2][0] === "enter" && events[index2][1].type === "attentionSequence" && events[index2][1]._close) {
      let open = index2;
      while (open--) {
        if (events[open][0] === "exit" && events[open][1].type === "attentionSequence" && events[open][1]._open && // If the markers are the same:
        context.sliceSerialize(events[open][1]).charCodeAt(0) === context.sliceSerialize(events[index2][1]).charCodeAt(0)) {
          if ((events[open][1]._close || events[index2][1]._open) && (events[index2][1].end.offset - events[index2][1].start.offset) % 3 && !((events[open][1].end.offset - events[open][1].start.offset + events[index2][1].end.offset - events[index2][1].start.offset) % 3)) {
            continue;
          }
          const use = events[open][1].end.offset - events[open][1].start.offset > 1 && events[index2][1].end.offset - events[index2][1].start.offset > 1 ? 2 : 1;
          const start = {
            ...events[open][1].end
          };
          const end = {
            ...events[index2][1].start
          };
          movePoint(start, -use);
          movePoint(end, use);
          const openingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start,
            end: {
              ...events[open][1].end
            }
          };
          const closingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start: {
              ...events[index2][1].start
            },
            end
          };
          const text3 = {
            type: use > 1 ? "strongText" : "emphasisText",
            start: {
              ...events[open][1].end
            },
            end: {
              ...events[index2][1].start
            }
          };
          const group = {
            type: use > 1 ? "strong" : "emphasis",
            start: {
              ...openingSequence.start
            },
            end: {
              ...closingSequence.end
            }
          };
          events[open][1].end = {
            ...openingSequence.start
          };
          events[index2][1].start = {
            ...closingSequence.end
          };
          nextEvents = [];
          if (events[open][1].end.offset - events[open][1].start.offset) {
            nextEvents = push(nextEvents, [["enter", events[open][1], context], ["exit", events[open][1], context]]);
          }
          nextEvents = push(nextEvents, [["enter", group, context], ["enter", openingSequence, context], ["exit", openingSequence, context], ["enter", text3, context]]);
          nextEvents = push(nextEvents, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open + 1, index2), context));
          nextEvents = push(nextEvents, [["exit", text3, context], ["enter", closingSequence, context], ["exit", closingSequence, context], ["exit", group, context]]);
          let offset = 0;
          if (events[index2][1].end.offset - events[index2][1].start.offset) {
            offset = 2;
            nextEvents = push(nextEvents, [["enter", events[index2][1], context], ["exit", events[index2][1], context]]);
          }
          splice(events, open - 1, index2 - open + 3, nextEvents);
          index2 = open + nextEvents.length - offset - 2;
          break;
        }
      }
    }
  }
  index2 = -1;
  while (++index2 < events.length) {
    if (events[index2][1].type === "attentionSequence") {
      events[index2][1].type = "data";
    }
  }
  return events;
}
function tokenizeAttention(effects, ok) {
  const attentionMarkers2 = this.parser.constructs.attentionMarkers.null;
  const previous2 = this.previous;
  const before = classifyCharacter(previous2);
  let marker;
  return start;
  function start(code) {
    marker = code;
    effects.enter("attentionSequence");
    return inside(code);
  }
  function inside(code) {
    if (code === marker) {
      effects.consume(code);
      return inside;
    }
    const token = effects.exit("attentionSequence");
    const after = classifyCharacter(code);
    const open = !after || after === 2 && before || attentionMarkers2.includes(code) && code !== 42 && code !== 95;
    const close = !before || before === 2 && after || attentionMarkers2.includes(previous2) && previous2 !== 42 && previous2 !== 95;
    token._open = Boolean(marker === 42 ? open : open && (before || !close));
    token._close = Boolean(marker === 42 ? close : close && (after || !open));
    return ok(code);
  }
}
function movePoint(point3, offset) {
  point3.column += offset;
  point3.offset += offset;
  point3._bufferIndex += offset;
}

// node_modules/micromark-core-commonmark/lib/autolink.js
var autolink = {
  name: "autolink",
  tokenize: tokenizeAutolink
};
function tokenizeAutolink(effects, ok, nok) {
  let size = 0;
  return start;
  function start(code) {
    effects.enter("autolink");
    effects.enter("autolinkMarker");
    effects.consume(code);
    effects.exit("autolinkMarker");
    effects.enter("autolinkProtocol");
    return open;
  }
  function open(code) {
    if (asciiAlpha(code)) {
      effects.consume(code);
      return schemeOrEmailAtext;
    }
    if (code === 64) {
      return nok(code);
    }
    return emailAtext(code);
  }
  function schemeOrEmailAtext(code) {
    if (code === 43 || code === 45 || code === 46 || asciiAlphanumeric(code)) {
      size = 1;
      return schemeInsideOrEmailAtext(code);
    }
    return emailAtext(code);
  }
  function schemeInsideOrEmailAtext(code) {
    if (code === 58) {
      effects.consume(code);
      size = 0;
      return urlInside;
    }
    if ((code === 43 || code === 45 || code === 46 || asciiAlphanumeric(code)) && size++ < 32) {
      effects.consume(code);
      return schemeInsideOrEmailAtext;
    }
    size = 0;
    return emailAtext(code);
  }
  function urlInside(code) {
    if (code === 62) {
      effects.exit("autolinkProtocol");
      effects.enter("autolinkMarker");
      effects.consume(code);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok;
    }
    if (code === null || code === 32 || code === 60 || asciiControl(code)) {
      return nok(code);
    }
    effects.consume(code);
    return urlInside;
  }
  function emailAtext(code) {
    if (code === 64) {
      effects.consume(code);
      return emailAtSignOrDot;
    }
    if (asciiAtext(code)) {
      effects.consume(code);
      return emailAtext;
    }
    return nok(code);
  }
  function emailAtSignOrDot(code) {
    return asciiAlphanumeric(code) ? emailLabel(code) : nok(code);
  }
  function emailLabel(code) {
    if (code === 46) {
      effects.consume(code);
      size = 0;
      return emailAtSignOrDot;
    }
    if (code === 62) {
      effects.exit("autolinkProtocol").type = "autolinkEmail";
      effects.enter("autolinkMarker");
      effects.consume(code);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok;
    }
    return emailValue(code);
  }
  function emailValue(code) {
    if ((code === 45 || asciiAlphanumeric(code)) && size++ < 63) {
      const next = code === 45 ? emailValue : emailLabel;
      effects.consume(code);
      return next;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/blank-line.js
var blankLine = {
  partial: true,
  tokenize: tokenizeBlankLine
};
function tokenizeBlankLine(effects, ok, nok) {
  return start;
  function start(code) {
    return markdownSpace(code) ? factorySpace(effects, after, "linePrefix")(code) : after(code);
  }
  function after(code) {
    return code === null || markdownLineEnding(code) ? ok(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/block-quote.js
var blockQuote = {
  continuation: {
    tokenize: tokenizeBlockQuoteContinuation
  },
  exit,
  name: "blockQuote",
  tokenize: tokenizeBlockQuoteStart
};
function tokenizeBlockQuoteStart(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    if (code === 62) {
      const state = self.containerState;
      if (!state.open) {
        effects.enter("blockQuote", {
          _container: true
        });
        state.open = true;
      }
      effects.enter("blockQuotePrefix");
      effects.enter("blockQuoteMarker");
      effects.consume(code);
      effects.exit("blockQuoteMarker");
      return after;
    }
    return nok(code);
  }
  function after(code) {
    if (markdownSpace(code)) {
      effects.enter("blockQuotePrefixWhitespace");
      effects.consume(code);
      effects.exit("blockQuotePrefixWhitespace");
      effects.exit("blockQuotePrefix");
      return ok;
    }
    effects.exit("blockQuotePrefix");
    return ok(code);
  }
}
function tokenizeBlockQuoteContinuation(effects, ok, nok) {
  const self = this;
  return contStart;
  function contStart(code) {
    if (markdownSpace(code)) {
      return factorySpace(effects, contBefore, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code);
    }
    return contBefore(code);
  }
  function contBefore(code) {
    return effects.attempt(blockQuote, ok, nok)(code);
  }
}
function exit(effects) {
  effects.exit("blockQuote");
}

// node_modules/micromark-core-commonmark/lib/character-escape.js
var characterEscape = {
  name: "characterEscape",
  tokenize: tokenizeCharacterEscape
};
function tokenizeCharacterEscape(effects, ok, nok) {
  return start;
  function start(code) {
    effects.enter("characterEscape");
    effects.enter("escapeMarker");
    effects.consume(code);
    effects.exit("escapeMarker");
    return inside;
  }
  function inside(code) {
    if (asciiPunctuation(code)) {
      effects.enter("characterEscapeValue");
      effects.consume(code);
      effects.exit("characterEscapeValue");
      effects.exit("characterEscape");
      return ok;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/character-reference.js
var characterReference = {
  name: "characterReference",
  tokenize: tokenizeCharacterReference
};
function tokenizeCharacterReference(effects, ok, nok) {
  const self = this;
  let size = 0;
  let max;
  let test;
  return start;
  function start(code) {
    effects.enter("characterReference");
    effects.enter("characterReferenceMarker");
    effects.consume(code);
    effects.exit("characterReferenceMarker");
    return open;
  }
  function open(code) {
    if (code === 35) {
      effects.enter("characterReferenceMarkerNumeric");
      effects.consume(code);
      effects.exit("characterReferenceMarkerNumeric");
      return numeric;
    }
    effects.enter("characterReferenceValue");
    max = 31;
    test = asciiAlphanumeric;
    return value(code);
  }
  function numeric(code) {
    if (code === 88 || code === 120) {
      effects.enter("characterReferenceMarkerHexadecimal");
      effects.consume(code);
      effects.exit("characterReferenceMarkerHexadecimal");
      effects.enter("characterReferenceValue");
      max = 6;
      test = asciiHexDigit;
      return value;
    }
    effects.enter("characterReferenceValue");
    max = 7;
    test = asciiDigit;
    return value(code);
  }
  function value(code) {
    if (code === 59 && size) {
      const token = effects.exit("characterReferenceValue");
      if (test === asciiAlphanumeric && !decodeNamedCharacterReference(self.sliceSerialize(token))) {
        return nok(code);
      }
      effects.enter("characterReferenceMarker");
      effects.consume(code);
      effects.exit("characterReferenceMarker");
      effects.exit("characterReference");
      return ok;
    }
    if (test(code) && size++ < max) {
      effects.consume(code);
      return value;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/partial-non-lazy-continuation.js
var nonLazyContinuation = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation
};
function tokenizeNonLazyContinuation(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    if (code === null) {
      return nok(code);
    }
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return after;
  }
  function after(code) {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/code-fenced.js
var codeFenced = {
  concrete: true,
  name: "codeFenced",
  tokenize: tokenizeCodeFenced
};
function tokenizeCodeFenced(effects, ok, nok) {
  const self = this;
  const closeStart = {
    partial: true,
    tokenize: tokenizeCloseStart
  };
  let initialPrefix = 0;
  let sizeOpen = 0;
  let marker;
  return start;
  function start(code) {
    return beforeSequenceOpen(code);
  }
  function beforeSequenceOpen(code) {
    const tail = self.events[self.events.length - 1];
    initialPrefix = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
    marker = code;
    effects.enter("codeFenced");
    effects.enter("codeFencedFence");
    effects.enter("codeFencedFenceSequence");
    return sequenceOpen(code);
  }
  function sequenceOpen(code) {
    if (code === marker) {
      sizeOpen++;
      effects.consume(code);
      return sequenceOpen;
    }
    if (sizeOpen < 3) {
      return nok(code);
    }
    effects.exit("codeFencedFenceSequence");
    return markdownSpace(code) ? factorySpace(effects, infoBefore, "whitespace")(code) : infoBefore(code);
  }
  function infoBefore(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("codeFencedFence");
      return self.interrupt ? ok(code) : effects.check(nonLazyContinuation, atNonLazyBreak, after)(code);
    }
    effects.enter("codeFencedFenceInfo");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return info(code);
  }
  function info(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return infoBefore(code);
    }
    if (markdownSpace(code)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return factorySpace(effects, metaBefore, "whitespace")(code);
    }
    if (code === 96 && code === marker) {
      return nok(code);
    }
    effects.consume(code);
    return info;
  }
  function metaBefore(code) {
    if (code === null || markdownLineEnding(code)) {
      return infoBefore(code);
    }
    effects.enter("codeFencedFenceMeta");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return meta(code);
  }
  function meta(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceMeta");
      return infoBefore(code);
    }
    if (code === 96 && code === marker) {
      return nok(code);
    }
    effects.consume(code);
    return meta;
  }
  function atNonLazyBreak(code) {
    return effects.attempt(closeStart, after, contentBefore)(code);
  }
  function contentBefore(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return contentStart;
  }
  function contentStart(code) {
    return initialPrefix > 0 && markdownSpace(code) ? factorySpace(effects, beforeContentChunk, "linePrefix", initialPrefix + 1)(code) : beforeContentChunk(code);
  }
  function beforeContentChunk(code) {
    if (code === null || markdownLineEnding(code)) {
      return effects.check(nonLazyContinuation, atNonLazyBreak, after)(code);
    }
    effects.enter("codeFlowValue");
    return contentChunk(code);
  }
  function contentChunk(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("codeFlowValue");
      return beforeContentChunk(code);
    }
    effects.consume(code);
    return contentChunk;
  }
  function after(code) {
    effects.exit("codeFenced");
    return ok(code);
  }
  function tokenizeCloseStart(effects2, ok2, nok2) {
    let size = 0;
    return startBefore;
    function startBefore(code) {
      effects2.enter("lineEnding");
      effects2.consume(code);
      effects2.exit("lineEnding");
      return start2;
    }
    function start2(code) {
      effects2.enter("codeFencedFence");
      return markdownSpace(code) ? factorySpace(effects2, beforeSequenceClose, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code) : beforeSequenceClose(code);
    }
    function beforeSequenceClose(code) {
      if (code === marker) {
        effects2.enter("codeFencedFenceSequence");
        return sequenceClose(code);
      }
      return nok2(code);
    }
    function sequenceClose(code) {
      if (code === marker) {
        size++;
        effects2.consume(code);
        return sequenceClose;
      }
      if (size >= sizeOpen) {
        effects2.exit("codeFencedFenceSequence");
        return markdownSpace(code) ? factorySpace(effects2, sequenceCloseAfter, "whitespace")(code) : sequenceCloseAfter(code);
      }
      return nok2(code);
    }
    function sequenceCloseAfter(code) {
      if (code === null || markdownLineEnding(code)) {
        effects2.exit("codeFencedFence");
        return ok2(code);
      }
      return nok2(code);
    }
  }
}

// node_modules/micromark-core-commonmark/lib/code-indented.js
var codeIndented = {
  name: "codeIndented",
  tokenize: tokenizeCodeIndented
};
var furtherStart = {
  partial: true,
  tokenize: tokenizeFurtherStart
};
function tokenizeCodeIndented(effects, ok, nok) {
  return start;
  function start(code) {
    effects.enter("codeIndented");
    return factorySpaceMinMax(effects, atBreak, nok, "linePrefix", 4, 4)(code);
  }
  function atBreak(code) {
    if (code === null) {
      return after(code);
    }
    if (markdownLineEnding(code)) {
      return effects.attempt(furtherStart, atBreak, after)(code);
    }
    effects.enter("codeFlowValue");
    return inside(code);
  }
  function inside(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("codeFlowValue");
      return atBreak(code);
    }
    effects.consume(code);
    return inside;
  }
  function after(code) {
    effects.exit("codeIndented");
    return ok(code);
  }
}
function tokenizeFurtherStart(effects, ok, nok) {
  const self = this;
  return furtherStart2;
  function furtherStart2(code) {
    if (self.parser.lazy[self.now().line]) {
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return furtherStart2;
    }
    return factorySpaceMinMax(effects, ok, onNotEnoughPrefix, "linePrefix", 4, 4)(code);
  }
  function onNotEnoughPrefix(code) {
    return markdownLineEnding(code) ? furtherStart2(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/code-text.js
var codeText = {
  name: "codeText",
  previous,
  resolve: resolveCodeText,
  tokenize: tokenizeCodeText
};
function resolveCodeText(events) {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index2;
  let enter;
  if ((events[headEnterIndex][1].type === "lineEnding" || events[headEnterIndex][1].type === "space") && (events[tailExitIndex][1].type === "lineEnding" || events[tailExitIndex][1].type === "space")) {
    index2 = headEnterIndex;
    while (++index2 < tailExitIndex) {
      if (events[index2][1].type === "codeTextData") {
        events[headEnterIndex][1].type = "codeTextPadding";
        events[tailExitIndex][1].type = "codeTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }
  index2 = headEnterIndex - 1;
  tailExitIndex++;
  while (++index2 <= tailExitIndex) {
    if (enter === void 0) {
      if (index2 !== tailExitIndex && events[index2][1].type !== "lineEnding") {
        enter = index2;
      }
    } else if (index2 === tailExitIndex || events[index2][1].type === "lineEnding") {
      events[enter][1].type = "codeTextData";
      if (index2 !== enter + 2) {
        events[enter][1].end = events[index2 - 1][1].end;
        events.splice(enter + 2, index2 - enter - 2);
        tailExitIndex -= index2 - enter - 2;
        index2 = enter + 2;
      }
      enter = void 0;
    }
  }
  return events;
}
function previous(code) {
  return code !== 96 || this.events[this.events.length - 1][1].type === "characterEscape";
}
function tokenizeCodeText(effects, ok, nok) {
  const self = this;
  let sizeOpen = 0;
  let size;
  let token;
  return start;
  function start(code) {
    effects.enter("codeText");
    effects.enter("codeTextSequence");
    return sequenceOpen(code);
  }
  function sequenceOpen(code) {
    if (code === 96) {
      effects.consume(code);
      sizeOpen++;
      return sequenceOpen;
    }
    effects.exit("codeTextSequence");
    return between(code);
  }
  function between(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 32) {
      effects.enter("space");
      effects.consume(code);
      effects.exit("space");
      return between;
    }
    if (code === 96) {
      token = effects.enter("codeTextSequence");
      size = 0;
      return sequenceClose(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return between;
    }
    effects.enter("codeTextData");
    return data(code);
  }
  function data(code) {
    if (code === null || code === 32 || code === 96 || markdownLineEnding(code)) {
      effects.exit("codeTextData");
      return between(code);
    }
    effects.consume(code);
    return data;
  }
  function sequenceClose(code) {
    if (code === 96) {
      effects.consume(code);
      size++;
      return sequenceClose;
    }
    if (size === sizeOpen) {
      effects.exit("codeTextSequence");
      effects.exit("codeText");
      return ok(code);
    }
    token.type = "codeTextData";
    return data(code);
  }
}

// node_modules/micromark-util-subtokenize/lib/splice-buffer.js
var SpliceBuffer = class {
  /**
   * @param {ReadonlyArray<T> | null | undefined} [initial]
   *   Initial items (optional).
   * @returns
   *   Splice buffer.
   */
  constructor(initial) {
    this.left = initial ? [...initial] : [];
    this.right = [];
  }
  /**
   * Array access;
   * does not move the cursor.
   *
   * @param {number} index
   *   Index.
   * @return {T}
   *   Item.
   */
  get(index2) {
    if (index2 < 0 || index2 >= this.left.length + this.right.length) {
      throw new RangeError("Cannot access index `" + index2 + "` in a splice buffer of size `" + (this.left.length + this.right.length) + "`");
    }
    if (index2 < this.left.length) return this.left[index2];
    return this.right[this.right.length - index2 + this.left.length - 1];
  }
  /**
   * The length of the splice buffer, one greater than the largest index in the
   * array.
   */
  get length() {
    return this.left.length + this.right.length;
  }
  /**
   * Remove and return `list[0]`;
   * moves the cursor to `0`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  shift() {
    this.setCursor(0);
    return this.right.pop();
  }
  /**
   * Slice the buffer to get an array;
   * does not move the cursor.
   *
   * @param {number} start
   *   Start.
   * @param {number | null | undefined} [end]
   *   End (optional).
   * @returns {Array<T>}
   *   Array of items.
   */
  slice(start, end) {
    const stop = end === null || end === void 0 ? Number.POSITIVE_INFINITY : end;
    if (stop < this.left.length) {
      return this.left.slice(start, stop);
    }
    if (start > this.left.length) {
      return this.right.slice(this.right.length - stop + this.left.length, this.right.length - start + this.left.length).reverse();
    }
    return this.left.slice(start).concat(this.right.slice(this.right.length - stop + this.left.length).reverse());
  }
  /**
   * Mimics the behavior of Array.prototype.splice() except for the change of
   * interface necessary to avoid segfaults when patching in very large arrays.
   *
   * This operation moves cursor is moved to `start` and results in the cursor
   * placed after any inserted items.
   *
   * @param {number} start
   *   Start;
   *   zero-based index at which to start changing the array;
   *   negative numbers count backwards from the end of the array and values
   *   that are out-of bounds are clamped to the appropriate end of the array.
   * @param {number | null | undefined} [deleteCount=0]
   *   Delete count (default: `0`);
   *   maximum number of elements to delete, starting from start.
   * @param {Array<T> | null | undefined} [items=[]]
   *   Items to include in place of the deleted items (default: `[]`).
   * @return {Array<T>}
   *   Any removed items.
   */
  splice(start, deleteCount, items) {
    const count = deleteCount || 0;
    this.setCursor(Math.trunc(start));
    const removed = this.right.splice(this.right.length - count, Number.POSITIVE_INFINITY);
    if (items) chunkedPush(this.left, items);
    return removed.reverse();
  }
  /**
   * Remove and return the highest-numbered item in the array, so
   * `list[list.length - 1]`;
   * Moves the cursor to `length`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  pop() {
    this.setCursor(Number.POSITIVE_INFINITY);
    return this.left.pop();
  }
  /**
   * Inserts a single item to the high-numbered side of the array;
   * moves the cursor to `length`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  push(item) {
    this.setCursor(Number.POSITIVE_INFINITY);
    this.left.push(item);
  }
  /**
   * Inserts many items to the high-numbered side of the array.
   * Moves the cursor to `length`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  pushMany(items) {
    this.setCursor(Number.POSITIVE_INFINITY);
    chunkedPush(this.left, items);
  }
  /**
   * Inserts a single item to the low-numbered side of the array;
   * Moves the cursor to `0`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  unshift(item) {
    this.setCursor(0);
    this.right.push(item);
  }
  /**
   * Inserts many items to the low-numbered side of the array;
   * moves the cursor to `0`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  unshiftMany(items) {
    this.setCursor(0);
    chunkedPush(this.right, items.reverse());
  }
  /**
   * Move the cursor to a specific position in the array. Requires
   * time proportional to the distance moved.
   *
   * If `n < 0`, the cursor will end up at the beginning.
   * If `n > length`, the cursor will end up at the end.
   *
   * @param {number} n
   *   Position.
   * @return {undefined}
   *   Nothing.
   */
  setCursor(n) {
    if (n === this.left.length || n > this.left.length && this.right.length === 0 || n < 0 && this.left.length === 0) return;
    if (n < this.left.length) {
      const removed = this.left.splice(n, Number.POSITIVE_INFINITY);
      chunkedPush(this.right, removed.reverse());
    } else {
      const removed = this.right.splice(this.left.length + this.right.length - n, Number.POSITIVE_INFINITY);
      chunkedPush(this.left, removed.reverse());
    }
  }
};
function chunkedPush(list2, right) {
  let chunkStart = 0;
  if (right.length < 1e4) {
    list2.push(...right);
  } else {
    while (chunkStart < right.length) {
      list2.push(...right.slice(chunkStart, chunkStart + 1e4));
      chunkStart += 1e4;
    }
  }
}

// node_modules/micromark-util-subtokenize/index.js
function subtokenize(eventsArray) {
  const jumps = {};
  let index2 = -1;
  let event;
  let lineIndex;
  let otherIndex;
  let otherEvent;
  let parameters;
  let subevents;
  let more;
  const events = new SpliceBuffer(eventsArray);
  while (++index2 < events.length) {
    while (index2 in jumps) {
      index2 = jumps[index2];
    }
    event = events.get(index2);
    if (index2 && event[1].type === "chunkFlow" && events.get(index2 - 1)[1].type === "listItemPrefix") {
      subevents = event[1]._tokenizer.events;
      otherIndex = 0;
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "lineEndingBlank") {
        otherIndex += 2;
      }
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "content") {
        while (++otherIndex < subevents.length) {
          if (subevents[otherIndex][1].type === "content") {
            break;
          }
          if (subevents[otherIndex][1].type === "chunkText") {
            subevents[otherIndex][1]._isInFirstContentOfListItem = true;
            otherIndex++;
          }
        }
      }
    }
    if (event[0] === "enter") {
      if (event[1].contentType) {
        Object.assign(jumps, subcontent(events, index2));
        index2 = jumps[index2];
        more = true;
      }
    } else if (event[1]._container) {
      otherIndex = index2;
      lineIndex = void 0;
      while (otherIndex--) {
        otherEvent = events.get(otherIndex);
        if (otherEvent[1].type === "lineEnding" || otherEvent[1].type === "lineEndingBlank") {
          if (otherEvent[0] === "enter") {
            if (lineIndex) {
              events.get(lineIndex)[1].type = "lineEndingBlank";
            }
            otherEvent[1].type = "lineEnding";
            lineIndex = otherIndex;
          }
        } else if (otherEvent[1].type === "linePrefix" || otherEvent[1].type === "listItemIndent") {
        } else {
          break;
        }
      }
      if (lineIndex) {
        event[1].end = {
          ...events.get(lineIndex)[1].start
        };
        parameters = events.slice(lineIndex, index2);
        parameters.unshift(event);
        events.splice(lineIndex, index2 - lineIndex + 1, parameters);
      }
    }
  }
  splice(eventsArray, 0, Number.POSITIVE_INFINITY, events.slice(0));
  return !more;
}
function subcontent(events, eventIndex) {
  const token = events.get(eventIndex)[1];
  const context = events.get(eventIndex)[2];
  let startPosition = eventIndex - 1;
  const startPositions = [];
  let tokenizer = token._tokenizer;
  if (!tokenizer) {
    tokenizer = context.parser[token.contentType](token.start);
    if (token._contentTypeTextTrailing) {
      tokenizer._contentTypeTextTrailing = true;
    }
  }
  const childEvents = tokenizer.events;
  const jumps = [];
  const gaps = {};
  let stream;
  let previous2;
  let index2 = -1;
  let current = token;
  let adjust = 0;
  let start = 0;
  const breaks = [start];
  while (current) {
    while (events.get(++startPosition)[1] !== current) {
    }
    startPositions.push(startPosition);
    if (!current._tokenizer) {
      stream = context.sliceStream(current);
      if (!current.next) {
        stream.push(null);
      }
      if (previous2) {
        tokenizer.defineSkip(current.start);
      }
      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = true;
      }
      tokenizer.write(stream);
      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = void 0;
      }
    }
    previous2 = current;
    current = current.next;
  }
  current = token;
  while (++index2 < childEvents.length) {
    if (
      // Find a void token that includes a break.
      childEvents[index2][0] === "exit" && childEvents[index2 - 1][0] === "enter" && childEvents[index2][1].type === childEvents[index2 - 1][1].type && childEvents[index2][1].start.line !== childEvents[index2][1].end.line
    ) {
      start = index2 + 1;
      breaks.push(start);
      current._tokenizer = void 0;
      current.previous = void 0;
      current = current.next;
    }
  }
  tokenizer.events = [];
  if (current) {
    current._tokenizer = void 0;
    current.previous = void 0;
  } else {
    breaks.pop();
  }
  index2 = breaks.length;
  while (index2--) {
    const slice = childEvents.slice(breaks[index2], breaks[index2 + 1]);
    const start2 = startPositions.pop();
    jumps.push([start2, start2 + slice.length - 1]);
    events.splice(start2, 2, slice);
  }
  jumps.reverse();
  index2 = -1;
  while (++index2 < jumps.length) {
    gaps[adjust + jumps[index2][0]] = adjust + jumps[index2][1];
    adjust += jumps[index2][1] - jumps[index2][0] - 1;
  }
  return gaps;
}

// node_modules/micromark-core-commonmark/lib/content.js
var content2 = {
  resolve: resolveContent,
  tokenize: tokenizeContent
};
var continuationConstruct = {
  partial: true,
  tokenize: tokenizeContinuation
};
function resolveContent(events) {
  subtokenize(events);
  return events;
}
function tokenizeContent(effects, ok) {
  let previous2;
  return chunkStart;
  function chunkStart(code) {
    effects.enter("content");
    previous2 = effects.enter("chunkContent", {
      contentType: "content"
    });
    return chunkInside(code);
  }
  function chunkInside(code) {
    if (code === null) {
      return contentEnd(code);
    }
    if (markdownLineEnding(code)) {
      return effects.check(continuationConstruct, contentContinue, contentEnd)(code);
    }
    effects.consume(code);
    return chunkInside;
  }
  function contentEnd(code) {
    effects.exit("chunkContent");
    effects.exit("content");
    return ok(code);
  }
  function contentContinue(code) {
    effects.consume(code);
    effects.exit("chunkContent");
    previous2.next = effects.enter("chunkContent", {
      contentType: "content",
      previous: previous2
    });
    previous2 = previous2.next;
    return chunkInside;
  }
}
function tokenizeContinuation(effects, ok, nok) {
  const self = this;
  return startLookahead;
  function startLookahead(code) {
    effects.exit("chunkContent");
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return factorySpace(effects, prefixed, "linePrefix");
  }
  function prefixed(code) {
    if (code === null || markdownLineEnding(code)) {
      return nok(code);
    }
    const tail = self.events[self.events.length - 1];
    if (!self.parser.constructs.disable.null.includes("codeIndented") && tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4) {
      return ok(code);
    }
    return effects.interrupt(self.parser.constructs.flow, nok, ok)(code);
  }
}

// node_modules/micromark-factory-destination/index.js
function factoryDestination(effects, ok, nok, type, literalType, literalMarkerType, rawType, stringType, max) {
  const limit = max || Number.POSITIVE_INFINITY;
  let balance = 0;
  return start;
  function start(code) {
    if (code === 60) {
      effects.enter(type);
      effects.enter(literalType);
      effects.enter(literalMarkerType);
      effects.consume(code);
      effects.exit(literalMarkerType);
      return enclosedBefore;
    }
    if (code === null || code === 32 || code === 41 || asciiControl(code)) {
      return nok(code);
    }
    effects.enter(type);
    effects.enter(rawType);
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return raw(code);
  }
  function enclosedBefore(code) {
    if (code === 62) {
      effects.enter(literalMarkerType);
      effects.consume(code);
      effects.exit(literalMarkerType);
      effects.exit(literalType);
      effects.exit(type);
      return ok;
    }
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return enclosed(code);
  }
  function enclosed(code) {
    if (code === 62) {
      effects.exit("chunkString");
      effects.exit(stringType);
      return enclosedBefore(code);
    }
    if (code === null || code === 60 || markdownLineEnding(code)) {
      return nok(code);
    }
    effects.consume(code);
    return code === 92 ? enclosedEscape : enclosed;
  }
  function enclosedEscape(code) {
    if (code === 60 || code === 62 || code === 92) {
      effects.consume(code);
      return enclosed;
    }
    return enclosed(code);
  }
  function raw(code) {
    if (!balance && (code === null || code === 41 || markdownLineEndingOrSpace(code))) {
      effects.exit("chunkString");
      effects.exit(stringType);
      effects.exit(rawType);
      effects.exit(type);
      return ok(code);
    }
    if (balance < limit && code === 40) {
      effects.consume(code);
      balance++;
      return raw;
    }
    if (code === 41) {
      effects.consume(code);
      balance--;
      return raw;
    }
    if (code === null || code === 32 || code === 40 || asciiControl(code)) {
      return nok(code);
    }
    effects.consume(code);
    return code === 92 ? rawEscape : raw;
  }
  function rawEscape(code) {
    if (code === 40 || code === 41 || code === 92) {
      effects.consume(code);
      return raw;
    }
    return raw(code);
  }
}

// node_modules/micromark-factory-label/index.js
function factoryLabel(effects, ok, nok, type, markerType, stringType) {
  const self = this;
  let size = 0;
  let seen;
  return start;
  function start(code) {
    effects.enter(type);
    effects.enter(markerType);
    effects.consume(code);
    effects.exit(markerType);
    effects.enter(stringType);
    return atBreak;
  }
  function atBreak(code) {
    if (size > 999 || code === null || code === 91 || code === 93 && !seen || // To do: remove in the future once we’ve switched from
    // `micromark-extension-footnote` to `micromark-extension-gfm-footnote`,
    // which doesn’t need this.
    // Hidden footnotes hook.
    /* c8 ignore next 3 */
    code === 94 && !size && "_hiddenFootnoteSupport" in self.parser.constructs) {
      return nok(code);
    }
    if (code === 93) {
      effects.exit(stringType);
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      effects.exit(type);
      return ok;
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return atBreak;
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return labelInside(code);
  }
  function labelInside(code) {
    if (code === null || code === 91 || code === 93 || markdownLineEnding(code) || size++ > 999) {
      effects.exit("chunkString");
      return atBreak(code);
    }
    effects.consume(code);
    if (!seen) seen = !markdownSpace(code);
    return code === 92 ? labelEscape : labelInside;
  }
  function labelEscape(code) {
    if (code === 91 || code === 92 || code === 93) {
      effects.consume(code);
      size++;
      return labelInside;
    }
    return labelInside(code);
  }
}

// node_modules/micromark-factory-title/index.js
function factoryTitle(effects, ok, nok, type, markerType, stringType) {
  let marker;
  return start;
  function start(code) {
    if (code === 34 || code === 39 || code === 40) {
      effects.enter(type);
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      marker = code === 40 ? 41 : code;
      return begin;
    }
    return nok(code);
  }
  function begin(code) {
    if (code === marker) {
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      effects.exit(type);
      return ok;
    }
    effects.enter(stringType);
    return atBreak(code);
  }
  function atBreak(code) {
    if (code === marker) {
      effects.exit(stringType);
      return begin(marker);
    }
    if (code === null) {
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return factorySpace(effects, atBreak, "linePrefix");
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return inside(code);
  }
  function inside(code) {
    if (code === marker || code === null || markdownLineEnding(code)) {
      effects.exit("chunkString");
      return atBreak(code);
    }
    effects.consume(code);
    return code === 92 ? escape : inside;
  }
  function escape(code) {
    if (code === marker || code === 92) {
      effects.consume(code);
      return inside;
    }
    return inside(code);
  }
}

// node_modules/micromark-factory-whitespace/index.js
function factoryWhitespace(effects, ok) {
  let seen;
  return start;
  function start(code) {
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      seen = true;
      return start;
    }
    if (markdownSpace(code)) {
      return factorySpace(effects, start, seen ? "linePrefix" : "lineSuffix")(code);
    }
    return ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/definition.js
var definition = {
  name: "definition",
  tokenize: tokenizeDefinition
};
var titleBefore = {
  partial: true,
  tokenize: tokenizeTitleBefore
};
function tokenizeDefinition(effects, ok, nok) {
  const self = this;
  let identifier;
  return start;
  function start(code) {
    effects.enter("definition");
    return before(code);
  }
  function before(code) {
    return factoryLabel.call(
      self,
      effects,
      labelAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionLabel",
      "definitionLabelMarker",
      "definitionLabelString"
    )(code);
  }
  function labelAfter(code) {
    identifier = normalizeIdentifier(self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1));
    if (code === 58) {
      effects.enter("definitionMarker");
      effects.consume(code);
      effects.exit("definitionMarker");
      return markerAfter;
    }
    return nok(code);
  }
  function markerAfter(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, destinationBefore)(code) : destinationBefore(code);
  }
  function destinationBefore(code) {
    return factoryDestination(
      effects,
      destinationAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionDestination",
      "definitionDestinationLiteral",
      "definitionDestinationLiteralMarker",
      "definitionDestinationRaw",
      "definitionDestinationString"
    )(code);
  }
  function destinationAfter(code) {
    return effects.attempt(titleBefore, after, after)(code);
  }
  function after(code) {
    return markdownSpace(code) ? factorySpace(effects, afterWhitespace, "whitespace")(code) : afterWhitespace(code);
  }
  function afterWhitespace(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("definition");
      self.parser.defined.push(identifier);
      return ok(code);
    }
    return nok(code);
  }
}
function tokenizeTitleBefore(effects, ok, nok) {
  return titleBefore2;
  function titleBefore2(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, beforeMarker)(code) : nok(code);
  }
  function beforeMarker(code) {
    return factoryTitle(effects, titleAfter, nok, "definitionTitle", "definitionTitleMarker", "definitionTitleString")(code);
  }
  function titleAfter(code) {
    return markdownSpace(code) ? factorySpace(effects, titleAfterOptionalWhitespace, "whitespace")(code) : titleAfterOptionalWhitespace(code);
  }
  function titleAfterOptionalWhitespace(code) {
    return code === null || markdownLineEnding(code) ? ok(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/hard-break-escape.js
var hardBreakEscape = {
  name: "hardBreakEscape",
  tokenize: tokenizeHardBreakEscape
};
function tokenizeHardBreakEscape(effects, ok, nok) {
  return start;
  function start(code) {
    effects.enter("hardBreakEscape");
    effects.consume(code);
    return after;
  }
  function after(code) {
    if (markdownLineEnding(code)) {
      effects.exit("hardBreakEscape");
      return ok(code);
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/heading-atx.js
var headingAtx = {
  name: "headingAtx",
  resolve: resolveHeadingAtx,
  tokenize: tokenizeHeadingAtx
};
function resolveHeadingAtx(events, context) {
  let contentEnd = events.length - 2;
  let contentStart = 3;
  if (events[contentStart][1].type === "whitespace") {
    contentStart += 2;
  }
  if (contentEnd - 2 > contentStart && events[contentEnd][1].type === "whitespace") {
    contentEnd -= 2;
  }
  if (events[contentEnd][1].type === "atxHeadingSequence" && (contentStart === contentEnd - 1 || contentEnd - 4 > contentStart && events[contentEnd - 2][1].type === "whitespace")) {
    contentEnd -= contentStart + 1 === contentEnd ? 2 : 4;
  }
  if (contentEnd > contentStart) {
    const content3 = {
      type: "atxHeadingText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end
    };
    const text3 = {
      type: "chunkText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end,
      contentType: "text"
    };
    splice(events, contentStart, contentEnd - contentStart + 1, [["enter", content3, context], ["enter", text3, context], ["exit", text3, context], ["exit", content3, context]]);
  }
  return events;
}
function tokenizeHeadingAtx(effects, ok, nok) {
  let size = 0;
  return start;
  function start(code) {
    effects.enter("atxHeading");
    return before(code);
  }
  function before(code) {
    effects.enter("atxHeadingSequence");
    return sequenceOpen(code);
  }
  function sequenceOpen(code) {
    if (code === 35 && size++ < 6) {
      effects.consume(code);
      return sequenceOpen;
    }
    if (code === null || markdownLineEndingOrSpace(code)) {
      effects.exit("atxHeadingSequence");
      return atBreak(code);
    }
    return nok(code);
  }
  function atBreak(code) {
    if (code === 35) {
      effects.enter("atxHeadingSequence");
      return sequenceFurther(code);
    }
    if (code === null || markdownLineEnding(code)) {
      effects.exit("atxHeading");
      return ok(code);
    }
    if (markdownSpace(code)) {
      return factorySpace(effects, atBreak, "whitespace")(code);
    }
    effects.enter("atxHeadingText");
    return data(code);
  }
  function sequenceFurther(code) {
    if (code === 35) {
      effects.consume(code);
      return sequenceFurther;
    }
    effects.exit("atxHeadingSequence");
    return atBreak(code);
  }
  function data(code) {
    if (code === null || code === 35 || markdownLineEndingOrSpace(code)) {
      effects.exit("atxHeadingText");
      return atBreak(code);
    }
    effects.consume(code);
    return data;
  }
}

// node_modules/micromark-util-html-tag-name/index.js
var htmlBlockNames = [
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul"
];
var htmlRawNames = ["pre", "script", "style", "textarea"];

// node_modules/micromark-core-commonmark/lib/html-flow.js
var htmlFlow = {
  concrete: true,
  name: "htmlFlow",
  resolveTo: resolveToHtmlFlow,
  tokenize: tokenizeHtmlFlow
};
var blankLineBefore = {
  partial: true,
  tokenize: tokenizeBlankLineBefore
};
function resolveToHtmlFlow(events) {
  let index2 = events.length;
  while (index2--) {
    if (events[index2][0] === "enter" && events[index2][1].type === "htmlFlow") {
      break;
    }
  }
  if (index2 > 1 && events[index2 - 2][1].type === "linePrefix") {
    events[index2][1].start = events[index2 - 2][1].start;
    events[index2 + 1][1].start = events[index2 - 2][1].start;
    events.splice(index2 - 2, 2);
  }
  return events;
}
function tokenizeHtmlFlow(effects, ok, nok) {
  const self = this;
  let marker;
  let closingTag;
  let buffer;
  let index2;
  let markerB;
  return start;
  function start(code) {
    return before(code);
  }
  function before(code) {
    effects.enter("htmlFlow");
    effects.enter("htmlFlowData");
    effects.consume(code);
    return open;
  }
  function open(code) {
    if (code === 33) {
      effects.consume(code);
      return declarationOpen;
    }
    if (code === 47) {
      effects.consume(code);
      closingTag = true;
      return tagCloseStart;
    }
    if (code === 63) {
      effects.consume(code);
      marker = 3;
      return self.interrupt ? ok : continuationDeclarationInside;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      buffer = String.fromCharCode(code);
      return tagName;
    }
    return nok(code);
  }
  function declarationOpen(code) {
    if (code === 45) {
      effects.consume(code);
      marker = 2;
      return commentOpenInside;
    }
    if (code === 91) {
      effects.consume(code);
      marker = 5;
      index2 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      marker = 4;
      return self.interrupt ? ok : continuationDeclarationInside;
    }
    return nok(code);
  }
  function commentOpenInside(code) {
    if (code === 45) {
      effects.consume(code);
      return self.interrupt ? ok : continuationDeclarationInside;
    }
    return nok(code);
  }
  function cdataOpenInside(code) {
    const value = "CDATA[";
    if (code === value.charCodeAt(index2++)) {
      effects.consume(code);
      if (index2 === value.length) {
        return self.interrupt ? ok : continuation;
      }
      return cdataOpenInside;
    }
    return nok(code);
  }
  function tagCloseStart(code) {
    if (asciiAlpha(code)) {
      effects.consume(code);
      buffer = String.fromCharCode(code);
      return tagName;
    }
    return nok(code);
  }
  function tagName(code) {
    if (code === null || code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      const slash = code === 47;
      const name = buffer.toLowerCase();
      if (!slash && !closingTag && htmlRawNames.includes(name)) {
        marker = 1;
        return self.interrupt ? ok(code) : continuation(code);
      }
      if (htmlBlockNames.includes(buffer.toLowerCase())) {
        marker = 6;
        if (slash) {
          effects.consume(code);
          return basicSelfClosing;
        }
        return self.interrupt ? ok(code) : continuation(code);
      }
      marker = 7;
      return self.interrupt && !self.parser.lazy[self.now().line] ? nok(code) : closingTag ? completeClosingTagAfter(code) : completeAttributeNameBefore(code);
    }
    if (code === 45 || asciiAlphanumeric(code)) {
      effects.consume(code);
      buffer += String.fromCharCode(code);
      return tagName;
    }
    return nok(code);
  }
  function basicSelfClosing(code) {
    if (code === 62) {
      effects.consume(code);
      return self.interrupt ? ok : continuation;
    }
    return nok(code);
  }
  function completeClosingTagAfter(code) {
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeClosingTagAfter;
    }
    return completeEnd(code);
  }
  function completeAttributeNameBefore(code) {
    if (code === 47) {
      effects.consume(code);
      return completeEnd;
    }
    if (code === 58 || code === 95 || asciiAlpha(code)) {
      effects.consume(code);
      return completeAttributeName;
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAttributeNameBefore;
    }
    return completeEnd(code);
  }
  function completeAttributeName(code) {
    if (code === 45 || code === 46 || code === 58 || code === 95 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return completeAttributeName;
    }
    return completeAttributeNameAfter(code);
  }
  function completeAttributeNameAfter(code) {
    if (code === 61) {
      effects.consume(code);
      return completeAttributeValueBefore;
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAttributeNameAfter;
    }
    return completeAttributeNameBefore(code);
  }
  function completeAttributeValueBefore(code) {
    if (code === null || code === 60 || code === 61 || code === 62 || code === 96) {
      return nok(code);
    }
    if (code === 34 || code === 39) {
      effects.consume(code);
      markerB = code;
      return completeAttributeValueQuoted;
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAttributeValueBefore;
    }
    return completeAttributeValueUnquoted(code);
  }
  function completeAttributeValueQuoted(code) {
    if (code === markerB) {
      effects.consume(code);
      markerB = null;
      return completeAttributeValueQuotedAfter;
    }
    if (code === null || markdownLineEnding(code)) {
      return nok(code);
    }
    effects.consume(code);
    return completeAttributeValueQuoted;
  }
  function completeAttributeValueUnquoted(code) {
    if (code === null || code === 34 || code === 39 || code === 47 || code === 60 || code === 61 || code === 62 || code === 96 || markdownLineEndingOrSpace(code)) {
      return completeAttributeNameAfter(code);
    }
    effects.consume(code);
    return completeAttributeValueUnquoted;
  }
  function completeAttributeValueQuotedAfter(code) {
    if (code === 47 || code === 62 || markdownSpace(code)) {
      return completeAttributeNameBefore(code);
    }
    return nok(code);
  }
  function completeEnd(code) {
    if (code === 62) {
      effects.consume(code);
      return completeAfter;
    }
    return nok(code);
  }
  function completeAfter(code) {
    if (code === null || markdownLineEnding(code)) {
      return continuation(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAfter;
    }
    return nok(code);
  }
  function continuation(code) {
    if (code === 45 && marker === 2) {
      effects.consume(code);
      return continuationCommentInside;
    }
    if (code === 60 && marker === 1) {
      effects.consume(code);
      return continuationRawTagOpen;
    }
    if (code === 62 && marker === 4) {
      effects.consume(code);
      return continuationClose;
    }
    if (code === 63 && marker === 3) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    if (code === 93 && marker === 5) {
      effects.consume(code);
      return continuationCdataInside;
    }
    if (markdownLineEnding(code) && (marker === 6 || marker === 7)) {
      effects.exit("htmlFlowData");
      return effects.check(blankLineBefore, continuationAfter, continuationStart)(code);
    }
    if (code === null || markdownLineEnding(code)) {
      effects.exit("htmlFlowData");
      return continuationStart(code);
    }
    effects.consume(code);
    return continuation;
  }
  function continuationStart(code) {
    return effects.check(nonLazyContinuation, continuationStartNonLazy, continuationAfter)(code);
  }
  function continuationStartNonLazy(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return continuationBefore;
  }
  function continuationBefore(code) {
    if (code === null || markdownLineEnding(code)) {
      return continuationStart(code);
    }
    effects.enter("htmlFlowData");
    return continuation(code);
  }
  function continuationCommentInside(code) {
    if (code === 45) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    return continuation(code);
  }
  function continuationRawTagOpen(code) {
    if (code === 47) {
      effects.consume(code);
      buffer = "";
      return continuationRawEndTag;
    }
    return continuation(code);
  }
  function continuationRawEndTag(code) {
    if (code === 62) {
      const name = buffer.toLowerCase();
      if (htmlRawNames.includes(name)) {
        effects.consume(code);
        return continuationClose;
      }
      return continuation(code);
    }
    if (asciiAlpha(code) && buffer.length < 8) {
      effects.consume(code);
      buffer += String.fromCharCode(code);
      return continuationRawEndTag;
    }
    return continuation(code);
  }
  function continuationCdataInside(code) {
    if (code === 93) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    return continuation(code);
  }
  function continuationDeclarationInside(code) {
    if (code === 62) {
      effects.consume(code);
      return continuationClose;
    }
    if (code === 45 && marker === 2) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    return continuation(code);
  }
  function continuationClose(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("htmlFlowData");
      return continuationAfter(code);
    }
    effects.consume(code);
    return continuationClose;
  }
  function continuationAfter(code) {
    effects.exit("htmlFlow");
    return ok(code);
  }
}
function tokenizeBlankLineBefore(effects, ok, nok) {
  return start;
  function start(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return effects.attempt(blankLine, ok, nok);
  }
}

// node_modules/micromark-core-commonmark/lib/html-text.js
var htmlText = {
  name: "htmlText",
  tokenize: tokenizeHtmlText
};
function tokenizeHtmlText(effects, ok, nok) {
  const self = this;
  let marker;
  let index2;
  let returnState;
  return start;
  function start(code) {
    effects.enter("htmlText");
    effects.enter("htmlTextData");
    effects.consume(code);
    return open;
  }
  function open(code) {
    if (code === 33) {
      effects.consume(code);
      return declarationOpen;
    }
    if (code === 47) {
      effects.consume(code);
      return tagCloseStart;
    }
    if (code === 63) {
      effects.consume(code);
      return instruction;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      return tagOpen;
    }
    return nok(code);
  }
  function declarationOpen(code) {
    if (code === 45) {
      effects.consume(code);
      return commentOpenInside;
    }
    if (code === 91) {
      effects.consume(code);
      index2 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      return declaration;
    }
    return nok(code);
  }
  function commentOpenInside(code) {
    if (code === 45) {
      effects.consume(code);
      return commentEnd;
    }
    return nok(code);
  }
  function comment(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 45) {
      effects.consume(code);
      return commentClose;
    }
    if (markdownLineEnding(code)) {
      returnState = comment;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return comment;
  }
  function commentClose(code) {
    if (code === 45) {
      effects.consume(code);
      return commentEnd;
    }
    return comment(code);
  }
  function commentEnd(code) {
    return code === 62 ? end(code) : code === 45 ? commentClose(code) : comment(code);
  }
  function cdataOpenInside(code) {
    const value = "CDATA[";
    if (code === value.charCodeAt(index2++)) {
      effects.consume(code);
      return index2 === value.length ? cdata : cdataOpenInside;
    }
    return nok(code);
  }
  function cdata(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 93) {
      effects.consume(code);
      return cdataClose;
    }
    if (markdownLineEnding(code)) {
      returnState = cdata;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return cdata;
  }
  function cdataClose(code) {
    if (code === 93) {
      effects.consume(code);
      return cdataEnd;
    }
    return cdata(code);
  }
  function cdataEnd(code) {
    if (code === 62) {
      return end(code);
    }
    if (code === 93) {
      effects.consume(code);
      return cdataEnd;
    }
    return cdata(code);
  }
  function declaration(code) {
    if (code === null || code === 62) {
      return end(code);
    }
    if (markdownLineEnding(code)) {
      returnState = declaration;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return declaration;
  }
  function instruction(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 63) {
      effects.consume(code);
      return instructionClose;
    }
    if (markdownLineEnding(code)) {
      returnState = instruction;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return instruction;
  }
  function instructionClose(code) {
    return code === 62 ? end(code) : instruction(code);
  }
  function tagCloseStart(code) {
    if (asciiAlpha(code)) {
      effects.consume(code);
      return tagClose;
    }
    return nok(code);
  }
  function tagClose(code) {
    if (code === 45 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return tagClose;
    }
    return tagCloseBetween(code);
  }
  function tagCloseBetween(code) {
    if (markdownLineEnding(code)) {
      returnState = tagCloseBetween;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagCloseBetween;
    }
    return end(code);
  }
  function tagOpen(code) {
    if (code === 45 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return tagOpen;
    }
    if (code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      return tagOpenBetween(code);
    }
    return nok(code);
  }
  function tagOpenBetween(code) {
    if (code === 47) {
      effects.consume(code);
      return end;
    }
    if (code === 58 || code === 95 || asciiAlpha(code)) {
      effects.consume(code);
      return tagOpenAttributeName;
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenBetween;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagOpenBetween;
    }
    return end(code);
  }
  function tagOpenAttributeName(code) {
    if (code === 45 || code === 46 || code === 58 || code === 95 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return tagOpenAttributeName;
    }
    return tagOpenAttributeNameAfter(code);
  }
  function tagOpenAttributeNameAfter(code) {
    if (code === 61) {
      effects.consume(code);
      return tagOpenAttributeValueBefore;
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenAttributeNameAfter;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagOpenAttributeNameAfter;
    }
    return tagOpenBetween(code);
  }
  function tagOpenAttributeValueBefore(code) {
    if (code === null || code === 60 || code === 61 || code === 62 || code === 96) {
      return nok(code);
    }
    if (code === 34 || code === 39) {
      effects.consume(code);
      marker = code;
      return tagOpenAttributeValueQuoted;
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenAttributeValueBefore;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagOpenAttributeValueBefore;
    }
    effects.consume(code);
    return tagOpenAttributeValueUnquoted;
  }
  function tagOpenAttributeValueQuoted(code) {
    if (code === marker) {
      effects.consume(code);
      marker = void 0;
      return tagOpenAttributeValueQuotedAfter;
    }
    if (code === null) {
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenAttributeValueQuoted;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return tagOpenAttributeValueQuoted;
  }
  function tagOpenAttributeValueUnquoted(code) {
    if (code === null || code === 34 || code === 39 || code === 60 || code === 61 || code === 96) {
      return nok(code);
    }
    if (code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      return tagOpenBetween(code);
    }
    effects.consume(code);
    return tagOpenAttributeValueUnquoted;
  }
  function tagOpenAttributeValueQuotedAfter(code) {
    if (code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      return tagOpenBetween(code);
    }
    return nok(code);
  }
  function end(code) {
    if (code === 62) {
      effects.consume(code);
      effects.exit("htmlTextData");
      effects.exit("htmlText");
      return ok;
    }
    return nok(code);
  }
  function lineEndingBefore(code) {
    effects.exit("htmlTextData");
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return lineEndingAfter;
  }
  function lineEndingAfter(code) {
    return markdownSpace(code) ? factorySpace(effects, lineEndingAfterPrefix, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code) : lineEndingAfterPrefix(code);
  }
  function lineEndingAfterPrefix(code) {
    effects.enter("htmlTextData");
    return returnState(code);
  }
}

// node_modules/micromark-core-commonmark/lib/label-end.js
var labelEnd = {
  name: "labelEnd",
  resolveAll: resolveAllLabelEnd,
  resolveTo: resolveToLabelEnd,
  tokenize: tokenizeLabelEnd
};
var resourceConstruct = {
  tokenize: tokenizeResource
};
var referenceFullConstruct = {
  tokenize: tokenizeReferenceFull
};
var referenceCollapsedConstruct = {
  tokenize: tokenizeReferenceCollapsed
};
function resolveAllLabelEnd(events) {
  let index2 = -1;
  const newEvents = [];
  while (++index2 < events.length) {
    const token = events[index2][1];
    newEvents.push(events[index2]);
    if (token.type === "labelImage" || token.type === "labelLink" || token.type === "labelEnd") {
      const offset = token.type === "labelImage" ? 4 : 2;
      token.type = "data";
      index2 += offset;
    }
  }
  if (events.length !== newEvents.length) {
    splice(events, 0, events.length, newEvents);
  }
  return events;
}
function resolveToLabelEnd(events, context) {
  let index2 = events.length;
  let offset = 0;
  let open;
  let close;
  let media;
  while (index2--) {
    const token = events[index2][1];
    if (open) {
      if (token.type === "link" || token.type === "labelLink" && token._inactive) {
        break;
      }
      if (events[index2][0] === "enter" && token.type === "labelLink") {
        token._inactive = true;
      }
    } else if (close) {
      if (events[index2][0] === "enter" && (token.type === "labelImage" || token.type === "labelLink") && !token._balanced) {
        open = index2;
        if (token.type !== "labelLink") {
          offset = 2;
          break;
        }
      }
    } else if (token.type === "labelEnd") {
      close = index2;
    }
  }
  const group = {
    type: events[open][1].type === "labelLink" ? "link" : "image",
    start: {
      ...events[open][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  const label = {
    type: "label",
    start: {
      ...events[open][1].start
    },
    end: {
      ...events[close][1].end
    }
  };
  const text3 = {
    type: "labelText",
    start: {
      ...events[open + offset + 2][1].end
    },
    end: {
      ...events[close - 2][1].start
    }
  };
  media = [["enter", group, context], ["enter", label, context]];
  media = push(media, events.slice(open + 1, open + offset + 3));
  media = push(media, [["enter", text3, context]]);
  media = push(media, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open + offset + 4, close - 3), context));
  media = push(media, [["exit", text3, context], events[close - 2], events[close - 1], ["exit", label, context]]);
  media = push(media, events.slice(close + 1));
  media = push(media, [["exit", group, context]]);
  splice(events, open, events.length, media);
  return events;
}
function tokenizeLabelEnd(effects, ok, nok) {
  const self = this;
  const labelStarts = self._labelStarts;
  let labelStart;
  let defined;
  if (labelStarts) {
    while (labelStarts.length > 0 && labelStarts[labelStarts.length - 1]._balanced) {
      labelStarts.pop();
    }
    labelStart = labelStarts[labelStarts.length - 1];
  }
  return start;
  function start(code) {
    if (!labelStart) {
      return nok(code);
    }
    if (labelStart._inactive) {
      return labelEndNok(code);
    }
    defined = self.parser.defined.includes(normalizeIdentifier(self.sliceSerialize({
      start: labelStart.end,
      end: self.now()
    })));
    effects.enter("labelEnd");
    effects.enter("labelMarker");
    effects.consume(code);
    effects.exit("labelMarker");
    effects.exit("labelEnd");
    return after;
  }
  function after(code) {
    if (code === 40) {
      return effects.attempt(resourceConstruct, labelEndOk, defined ? labelEndOk : labelEndNok)(code);
    }
    if (code === 91) {
      return effects.attempt(referenceFullConstruct, labelEndOk, defined ? referenceNotFull : labelEndNok)(code);
    }
    return defined ? labelEndOk(code) : labelEndNok(code);
  }
  function referenceNotFull(code) {
    return effects.attempt(referenceCollapsedConstruct, labelEndOk, labelEndNok)(code);
  }
  function labelEndOk(code) {
    labelStarts.pop();
    return ok(code);
  }
  function labelEndNok(code) {
    labelStart._balanced = true;
    return nok(code);
  }
}
function tokenizeResource(effects, ok, nok) {
  return resourceStart;
  function resourceStart(code) {
    effects.enter("resource");
    effects.enter("resourceMarker");
    effects.consume(code);
    effects.exit("resourceMarker");
    return resourceBefore;
  }
  function resourceBefore(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, resourceOpen)(code) : resourceOpen(code);
  }
  function resourceOpen(code) {
    if (code === 41) {
      return resourceEnd(code);
    }
    return factoryDestination(effects, resourceDestinationAfter, resourceDestinationMissing, "resourceDestination", "resourceDestinationLiteral", "resourceDestinationLiteralMarker", "resourceDestinationRaw", "resourceDestinationString", 32)(code);
  }
  function resourceDestinationAfter(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, resourceBetween)(code) : resourceEnd(code);
  }
  function resourceDestinationMissing(code) {
    return nok(code);
  }
  function resourceBetween(code) {
    if (code === 34 || code === 39 || code === 40) {
      return factoryTitle(effects, resourceTitleAfter, nok, "resourceTitle", "resourceTitleMarker", "resourceTitleString")(code);
    }
    return resourceEnd(code);
  }
  function resourceTitleAfter(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, resourceEnd)(code) : resourceEnd(code);
  }
  function resourceEnd(code) {
    if (code === 41) {
      effects.enter("resourceMarker");
      effects.consume(code);
      effects.exit("resourceMarker");
      effects.exit("resource");
      return ok;
    }
    return nok(code);
  }
}
function tokenizeReferenceFull(effects, ok, nok) {
  const self = this;
  return referenceFull;
  function referenceFull(code) {
    return factoryLabel.call(self, effects, referenceFullAfter, referenceFullMissing, "reference", "referenceMarker", "referenceString")(code);
  }
  function referenceFullAfter(code) {
    return self.parser.defined.includes(normalizeIdentifier(self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1))) ? ok(code) : nok(code);
  }
  function referenceFullMissing(code) {
    return nok(code);
  }
}
function tokenizeReferenceCollapsed(effects, ok, nok) {
  return referenceCollapsedStart;
  function referenceCollapsedStart(code) {
    effects.enter("reference");
    effects.enter("referenceMarker");
    effects.consume(code);
    effects.exit("referenceMarker");
    return referenceCollapsedOpen;
  }
  function referenceCollapsedOpen(code) {
    if (code === 93) {
      effects.enter("referenceMarker");
      effects.consume(code);
      effects.exit("referenceMarker");
      effects.exit("reference");
      return ok;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/label-start-image.js
var labelStartImage = {
  name: "labelStartImage",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartImage
};
function tokenizeLabelStartImage(effects, ok, nok) {
  const self = this;
  let labelImage;
  return start;
  function start(code) {
    effects.enter("labelImage");
    effects.enter("labelImageMarker");
    effects.consume(code);
    effects.exit("labelImageMarker");
    return open;
  }
  function open(code) {
    if (code === 91) {
      effects.enter("labelMarker");
      effects.consume(code);
      effects.exit("labelMarker");
      labelImage = effects.exit("labelImage");
      return after;
    }
    return nok(code);
  }
  function after(code) {
    if (code === 94 && "_hiddenFootnoteSupport" in self.parser.constructs) {
      return nok(code);
    }
    self._labelStarts = self._labelStarts || [];
    self._labelStarts.push(labelImage);
    return ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/label-start-link.js
var labelStartLink = {
  name: "labelStartLink",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartLink
};
function tokenizeLabelStartLink(effects, ok, nok) {
  const self = this;
  let labelLink;
  return start;
  function start(code) {
    effects.enter("labelLink");
    effects.enter("labelMarker");
    effects.consume(code);
    effects.exit("labelMarker");
    labelLink = effects.exit("labelLink");
    return after;
  }
  function after(code) {
    if (code === 94 && "_hiddenFootnoteSupport" in self.parser.constructs) {
      return nok(code);
    }
    self._labelStarts = self._labelStarts || [];
    self._labelStarts.push(labelLink);
    return ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/line-ending.js
var lineEnding = {
  name: "lineEnding",
  tokenize: tokenizeLineEnding
};
function tokenizeLineEnding(effects, ok) {
  return start;
  function start(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return factorySpace(effects, ok, "linePrefix");
  }
}

// node_modules/micromark-core-commonmark/lib/thematic-break.js
var thematicBreak = {
  name: "thematicBreak",
  tokenize: tokenizeThematicBreak
};
function tokenizeThematicBreak(effects, ok, nok) {
  let size = 0;
  let marker;
  return start;
  function start(code) {
    effects.enter("thematicBreak");
    return before(code);
  }
  function before(code) {
    marker = code;
    return atBreak(code);
  }
  function atBreak(code) {
    if (code === marker) {
      effects.enter("thematicBreakSequence");
      return sequence(code);
    }
    if (size >= 3 && (code === null || markdownLineEnding(code))) {
      effects.exit("thematicBreak");
      return ok(code);
    }
    return nok(code);
  }
  function sequence(code) {
    if (code === marker) {
      effects.consume(code);
      size++;
      return sequence;
    }
    effects.exit("thematicBreakSequence");
    return markdownSpace(code) ? factorySpace(effects, atBreak, "whitespace")(code) : atBreak(code);
  }
}

// node_modules/micromark-core-commonmark/lib/list.js
var list = {
  continuation: {
    tokenize: tokenizeListContinuation
  },
  exit: tokenizeListEnd,
  name: "list",
  tokenize: tokenizeListStart
};
var listItemPrefixWhitespaceConstruct = {
  partial: true,
  tokenize: tokenizeListItemPrefixWhitespace
};
var indentConstruct = {
  partial: true,
  tokenize: tokenizeIndent
};
function tokenizeListStart(effects, ok, nok) {
  const self = this;
  const tail = self.events[self.events.length - 1];
  let initialSize = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
  let size = 0;
  return start;
  function start(code) {
    const kind = self.containerState.type || (code === 42 || code === 43 || code === 45 ? "listUnordered" : "listOrdered");
    if (kind === "listUnordered" ? !self.containerState.marker || code === self.containerState.marker : asciiDigit(code)) {
      if (!self.containerState.type) {
        self.containerState.type = kind;
        effects.enter(kind, {
          _container: true
        });
      }
      if (kind === "listUnordered") {
        effects.enter("listItemPrefix");
        return code === 42 || code === 45 ? effects.check(thematicBreak, nok, atMarker)(code) : atMarker(code);
      }
      if (!self.interrupt || code === 49) {
        effects.enter("listItemPrefix");
        effects.enter("listItemValue");
        return inside(code);
      }
    }
    return nok(code);
  }
  function inside(code) {
    if (asciiDigit(code) && ++size < 10) {
      effects.consume(code);
      return inside;
    }
    if ((!self.interrupt || size < 2) && (self.containerState.marker ? code === self.containerState.marker : code === 41 || code === 46)) {
      effects.exit("listItemValue");
      return atMarker(code);
    }
    return nok(code);
  }
  function atMarker(code) {
    effects.enter("listItemMarker");
    effects.consume(code);
    effects.exit("listItemMarker");
    self.containerState.marker = self.containerState.marker || code;
    return effects.check(
      blankLine,
      // Can’t be empty when interrupting.
      self.interrupt ? nok : onBlank,
      effects.attempt(listItemPrefixWhitespaceConstruct, endOfPrefix, otherPrefix)
    );
  }
  function onBlank(code) {
    self.containerState.initialBlankLine = true;
    initialSize++;
    return endOfPrefix(code);
  }
  function otherPrefix(code) {
    if (markdownSpace(code)) {
      effects.enter("listItemPrefixWhitespace");
      effects.consume(code);
      effects.exit("listItemPrefixWhitespace");
      return endOfPrefix;
    }
    return nok(code);
  }
  function endOfPrefix(code) {
    self.containerState.size = initialSize + self.sliceSerialize(effects.exit("listItemPrefix"), true).length;
    return ok(code);
  }
}
function tokenizeListContinuation(effects, ok, nok) {
  const self = this;
  self.containerState._closeFlow = void 0;
  return effects.check(blankLine, onBlank, notBlank);
  function onBlank(code) {
    self.containerState.furtherBlankLines = self.containerState.furtherBlankLines || self.containerState.initialBlankLine;
    return factorySpace(effects, ok, "listItemIndent", self.containerState.size + 1)(code);
  }
  function notBlank(code) {
    if (self.containerState.furtherBlankLines || !markdownSpace(code)) {
      self.containerState.furtherBlankLines = void 0;
      self.containerState.initialBlankLine = void 0;
      return notInCurrentItem(code);
    }
    self.containerState.furtherBlankLines = void 0;
    self.containerState.initialBlankLine = void 0;
    return effects.attempt(indentConstruct, ok, notInCurrentItem)(code);
  }
  function notInCurrentItem(code) {
    self.containerState._closeFlow = true;
    self.interrupt = void 0;
    return factorySpace(effects, effects.attempt(list, ok, nok), "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code);
  }
}
function tokenizeIndent(effects, ok, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "listItemIndent", self.containerState.size + 1);
  function afterPrefix(code) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "listItemIndent" && tail[2].sliceSerialize(tail[1], true).length === self.containerState.size ? ok(code) : nok(code);
  }
}
function tokenizeListEnd(effects) {
  effects.exit(this.containerState.type);
}
function tokenizeListItemPrefixWhitespace(effects, ok, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "listItemPrefixWhitespace", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4 + 1);
  function afterPrefix(code) {
    const tail = self.events[self.events.length - 1];
    return !markdownSpace(code) && tail && tail[1].type === "listItemPrefixWhitespace" ? ok(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/setext-underline.js
var setextUnderline = {
  name: "setextUnderline",
  resolveTo: resolveToSetextUnderline,
  tokenize: tokenizeSetextUnderline
};
function resolveToSetextUnderline(events, context) {
  const editMap = new EditMap();
  let index2 = events.length;
  let content3;
  let text3;
  let definition2;
  while (index2--) {
    if (events[index2][0] === "enter") {
      if (events[index2][1].type === "content") {
        content3 = index2;
        break;
      }
      if (events[index2][1].type === "paragraph") {
        text3 = index2;
      }
    } else {
      if (events[index2][1].type === "content") {
        editMap.add(index2, 1, []);
      }
      if (!definition2 && events[index2][1].type === "definition") {
        definition2 = index2;
      }
    }
  }
  const heading = {
    type: "setextHeading",
    start: {
      ...events[content3][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  events[text3][1].type = "setextHeadingText";
  if (definition2) {
    editMap.add(text3, 0, [["enter", heading, context]]);
    editMap.add(definition2 + 1, 0, [["exit", events[content3][1], context]]);
    events[content3][1].end = {
      ...events[definition2][1].end
    };
  } else {
    events[content3][1] = heading;
  }
  editMap.add(events.length, 0, [["exit", heading, context]]);
  editMap.consume(events);
  return events;
}
function tokenizeSetextUnderline(effects, ok, nok) {
  const self = this;
  let marker;
  return start;
  function start(code) {
    let index2 = self.events.length;
    let paragraph;
    while (index2--) {
      if (self.events[index2][1].type !== "lineEnding" && self.events[index2][1].type !== "linePrefix" && self.events[index2][1].type !== "content") {
        paragraph = self.events[index2][1].type === "paragraph";
        break;
      }
    }
    if (!self.parser.lazy[self.now().line] && (self.interrupt || paragraph)) {
      effects.enter("setextHeadingLine");
      marker = code;
      return before(code);
    }
    return nok(code);
  }
  function before(code) {
    effects.enter("setextHeadingLineSequence");
    return inside(code);
  }
  function inside(code) {
    if (code === marker) {
      effects.consume(code);
      return inside;
    }
    effects.exit("setextHeadingLineSequence");
    return markdownSpace(code) ? factorySpace(effects, after, "lineSuffix")(code) : after(code);
  }
  function after(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("setextHeadingLine");
      return ok(code);
    }
    return nok(code);
  }
}

// node_modules/micromark/lib/initialize/flow.js
var flow = {
  tokenize: initializeFlow
};
function initializeFlow(effects) {
  const self = this;
  const initial = effects.attempt(
    // Try to parse a blank line.
    blankLine,
    atBlankEnding,
    // Try to parse initial flow (essentially, only code).
    effects.attempt(this.parser.constructs.flowInitial, afterConstruct, factorySpace(effects, effects.attempt(this.parser.constructs.flow, afterConstruct, effects.attempt(content2, afterConstruct)), "linePrefix"))
  );
  return initial;
  function atBlankEnding(code) {
    if (code === null) {
      effects.consume(code);
      return;
    }
    effects.enter("lineEndingBlank");
    effects.consume(code);
    effects.exit("lineEndingBlank");
    self.currentConstruct = void 0;
    return initial;
  }
  function afterConstruct(code) {
    if (code === null) {
      effects.consume(code);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    self.currentConstruct = void 0;
    return initial;
  }
}

// node_modules/micromark/lib/initialize/text.js
var resolver = {
  resolveAll: createResolver()
};
var string = initializeFactory("string");
var text = initializeFactory("text");
function initializeFactory(field) {
  return {
    resolveAll: createResolver(field === "text" ? resolveAllLineSuffixes : void 0),
    tokenize: initializeText
  };
  function initializeText(effects) {
    const self = this;
    const constructs2 = this.parser.constructs[field];
    const text3 = effects.attempt(constructs2, start, notText);
    return start;
    function start(code) {
      return atBreak(code) ? text3(code) : notText(code);
    }
    function notText(code) {
      if (code === null) {
        effects.consume(code);
        return;
      }
      effects.enter("data");
      effects.consume(code);
      return data;
    }
    function data(code) {
      if (atBreak(code)) {
        effects.exit("data");
        return text3(code);
      }
      effects.consume(code);
      return data;
    }
    function atBreak(code) {
      if (code === null) {
        return true;
      }
      const list2 = constructs2[code];
      let index2 = -1;
      if (list2) {
        while (++index2 < list2.length) {
          const item = list2[index2];
          if (!item.previous || item.previous.call(self, self.previous)) {
            return true;
          }
        }
      }
      return false;
    }
  }
}
function createResolver(extraResolver) {
  return resolveAllText;
  function resolveAllText(events, context) {
    let index2 = -1;
    let enter;
    while (++index2 <= events.length) {
      if (enter === void 0) {
        if (events[index2] && events[index2][1].type === "data") {
          enter = index2;
          index2++;
        }
      } else if (!events[index2] || events[index2][1].type !== "data") {
        if (index2 !== enter + 2) {
          events[enter][1].end = events[index2 - 1][1].end;
          events.splice(enter + 2, index2 - enter - 2);
          index2 = enter + 2;
        }
        enter = void 0;
      }
    }
    return extraResolver ? extraResolver(events, context) : events;
  }
}
function resolveAllLineSuffixes(events, context) {
  const editMap = new EditMap();
  let eventIndex = 0;
  while (++eventIndex <= events.length) {
    if ((eventIndex === events.length || events[eventIndex][1].type === "lineEnding") && events[eventIndex - 1][1].type === "data") {
      const data = events[eventIndex - 1][1];
      const chunks = context.sliceStream(data);
      let index2 = chunks.length;
      let bufferIndex = -1;
      let size = 0;
      let tabs;
      while (index2--) {
        const chunk2 = chunks[index2];
        if (typeof chunk2 === "string") {
          bufferIndex = chunk2.length;
          while (chunk2.charCodeAt(bufferIndex - 1) === 32) {
            size++;
            bufferIndex--;
          }
          if (bufferIndex) {
            break;
          }
          bufferIndex = -1;
        } else if (chunk2 === -2) {
          tabs = true;
          size++;
        } else if (chunk2 === -1) {
        } else {
          index2++;
          break;
        }
      }
      if (context._contentTypeTextTrailing && eventIndex === events.length) {
        size = 0;
      }
      if (size) {
        const token = {
          type: eventIndex === events.length || tabs || size < 2 ? "lineSuffix" : "hardBreakTrailing",
          start: {
            _bufferIndex: index2 ? bufferIndex : data.start._bufferIndex + bufferIndex,
            _index: data.start._index + index2,
            line: data.end.line,
            column: data.end.column - size,
            offset: data.end.offset - size
          },
          end: {
            ...data.end
          }
        };
        data.end = {
          ...token.start
        };
        if (data.start.offset === data.end.offset) {
          Object.assign(data, token);
        } else {
          editMap.add(eventIndex, 0, [["enter", token, context], ["exit", token, context]]);
        }
      }
      eventIndex++;
    }
  }
  editMap.consume(events);
  return events;
}

// node_modules/micromark/lib/constructs.js
var constructs_exports = {};
__export(constructs_exports, {
  attentionMarkers: () => attentionMarkers,
  contentInitial: () => contentInitial,
  disable: () => disable,
  document: () => document3,
  flow: () => flow2,
  flowInitial: () => flowInitial,
  insideSpan: () => insideSpan,
  string: () => string2,
  text: () => text2
});
var document3 = {
  [42]: list,
  [43]: list,
  [45]: list,
  [48]: list,
  [49]: list,
  [50]: list,
  [51]: list,
  [52]: list,
  [53]: list,
  [54]: list,
  [55]: list,
  [56]: list,
  [57]: list,
  [62]: blockQuote
};
var contentInitial = {
  [91]: definition
};
var flowInitial = {
  [-2]: codeIndented,
  [-1]: codeIndented,
  [32]: codeIndented
};
var flow2 = {
  [35]: headingAtx,
  [42]: thematicBreak,
  [45]: [setextUnderline, thematicBreak],
  [60]: htmlFlow,
  [61]: setextUnderline,
  [95]: thematicBreak,
  [96]: codeFenced,
  [126]: codeFenced
};
var string2 = {
  [38]: characterReference,
  [92]: characterEscape
};
var text2 = {
  [-5]: lineEnding,
  [-4]: lineEnding,
  [-3]: lineEnding,
  [33]: labelStartImage,
  [38]: characterReference,
  [42]: attention,
  [60]: [autolink, htmlText],
  [91]: labelStartLink,
  [92]: [hardBreakEscape, characterEscape],
  [93]: labelEnd,
  [95]: attention,
  [96]: codeText
};
var insideSpan = {
  null: [attention, resolver]
};
var attentionMarkers = {
  null: [42, 95]
};
var disable = {
  null: []
};

// node_modules/micromark/lib/create-tokenizer.js
function createTokenizer(parser, initialize, from) {
  let point3 = {
    _bufferIndex: -1,
    _index: 0,
    line: from && from.line || 1,
    column: from && from.column || 1,
    offset: from && from.offset || 0
  };
  const columnStart = {};
  const resolveAllConstructs = [];
  let chunks = [];
  let stack = [];
  let consumed = true;
  const effects = {
    attempt: constructFactory(onsuccessfulconstruct),
    check: constructFactory(onsuccessfulcheck),
    consume,
    enter,
    exit: exit2,
    interrupt: constructFactory(onsuccessfulcheck, {
      interrupt: true
    })
  };
  const context = {
    code: null,
    containerState: {},
    defineSkip,
    events: [],
    now: now2,
    parser,
    previous: null,
    sliceSerialize,
    sliceStream,
    write
  };
  let state = initialize.tokenize.call(context, effects);
  let expectedCode;
  if (initialize.resolveAll) {
    resolveAllConstructs.push(initialize);
  }
  return context;
  function write(slice) {
    chunks = push(chunks, slice);
    main();
    if (chunks[chunks.length - 1] !== null) {
      return [];
    }
    addResult(initialize, 0);
    context.events = resolveAll(resolveAllConstructs, context.events, context);
    return context.events;
  }
  function sliceSerialize(token, expandTabs) {
    return serializeChunks(sliceStream(token), expandTabs);
  }
  function sliceStream(token) {
    return sliceChunks(chunks, token);
  }
  function now2() {
    const {
      _bufferIndex,
      _index,
      line: line2,
      column,
      offset
    } = point3;
    return {
      _bufferIndex,
      _index,
      line: line2,
      column,
      offset
    };
  }
  function defineSkip(value) {
    columnStart[value.line] = value.column;
    accountForPotentialSkip();
  }
  function main() {
    while (point3._index < chunks.length) {
      const chunk2 = chunks[point3._index];
      if (typeof chunk2 === "string") {
        const chunkIndex = point3._index;
        if (point3._bufferIndex < 0) {
          point3._bufferIndex = 0;
        }
        while (point3._index === chunkIndex && point3._bufferIndex < chunk2.length) {
          go(chunk2.charCodeAt(point3._bufferIndex));
        }
      } else {
        go(chunk2);
      }
    }
  }
  function go(code) {
    consumed = void 0;
    expectedCode = code;
    state = state(code);
  }
  function consume(code) {
    if (markdownLineEnding(code)) {
      point3.line++;
      point3.column = 1;
      point3.offset += code === -3 ? 2 : 1;
      accountForPotentialSkip();
    } else if (code !== -1) {
      point3.column++;
      point3.offset++;
    }
    if (point3._bufferIndex < 0) {
      point3._index++;
    } else {
      point3._bufferIndex++;
      if (point3._bufferIndex === // Points w/ non-negative `_bufferIndex` reference
      // strings.
      /** @type {string} */
      chunks[point3._index].length) {
        point3._bufferIndex = -1;
        point3._index++;
      }
    }
    context.previous = code;
    consumed = true;
  }
  function enter(type, fields) {
    const token = fields || {};
    token.type = type;
    token.start = now2();
    context.events.push(["enter", token, context]);
    stack.push(token);
    return token;
  }
  function exit2(type) {
    const token = stack.pop();
    token.end = now2();
    context.events.push(["exit", token, context]);
    return token;
  }
  function onsuccessfulconstruct(construct, info) {
    addResult(construct, info.from);
  }
  function onsuccessfulcheck(_, info) {
    info.restore();
  }
  function constructFactory(onreturn, fields) {
    return hook;
    function hook(constructs2, returnState, bogusState) {
      let listOfConstructs;
      let constructIndex;
      let currentConstruct;
      let info;
      return Array.isArray(constructs2) ? (
        /* c8 ignore next 1 */
        handleListOfConstructs(constructs2)
      ) : "tokenize" in constructs2 ? (
        // Looks like a construct.
        handleListOfConstructs([
          /** @type {Construct} */
          constructs2
        ])
      ) : handleMapOfConstructs(constructs2);
      function handleMapOfConstructs(map) {
        return start;
        function start(code) {
          const left = code !== null && map[code];
          const all2 = code !== null && map.null;
          const list2 = [
            // To do: add more extension tests.
            /* c8 ignore next 2 */
            ...Array.isArray(left) ? left : left ? [left] : [],
            ...Array.isArray(all2) ? all2 : all2 ? [all2] : []
          ];
          return handleListOfConstructs(list2)(code);
        }
      }
      function handleListOfConstructs(list2) {
        listOfConstructs = list2;
        constructIndex = 0;
        if (list2.length === 0) {
          return bogusState;
        }
        return handleConstruct(list2[constructIndex]);
      }
      function handleConstruct(construct) {
        return start;
        function start(code) {
          info = store();
          currentConstruct = construct;
          if (!construct.partial) {
            context.currentConstruct = construct;
          }
          if (construct.name && context.parser.constructs.disable.null.includes(construct.name)) {
            return nok(code);
          }
          return construct.tokenize.call(
            // If we do have fields, create an object w/ `context` as its
            // prototype.
            // This allows a “live binding”, which is needed for `interrupt`.
            fields ? Object.assign(Object.create(context), fields) : context,
            effects,
            ok,
            nok
          )(code);
        }
      }
      function ok(code) {
        consumed = true;
        onreturn(currentConstruct, info);
        return returnState;
      }
      function nok(code) {
        consumed = true;
        info.restore();
        if (++constructIndex < listOfConstructs.length) {
          return handleConstruct(listOfConstructs[constructIndex]);
        }
        return bogusState;
      }
    }
  }
  function addResult(construct, from2) {
    if (construct.resolveAll && !resolveAllConstructs.includes(construct)) {
      resolveAllConstructs.push(construct);
    }
    if (construct.resolve) {
      splice(context.events, from2, context.events.length - from2, construct.resolve(context.events.slice(from2), context));
    }
    if (construct.resolveTo) {
      context.events = construct.resolveTo(context.events, context);
    }
  }
  function store() {
    const startPoint = now2();
    const startPrevious = context.previous;
    const startCurrentConstruct = context.currentConstruct;
    const startEventsIndex = context.events.length;
    const startStack = Array.from(stack);
    return {
      from: startEventsIndex,
      restore
    };
    function restore() {
      point3 = startPoint;
      context.previous = startPrevious;
      context.currentConstruct = startCurrentConstruct;
      context.events.length = startEventsIndex;
      stack = startStack;
      accountForPotentialSkip();
    }
  }
  function accountForPotentialSkip() {
    if (point3.line in columnStart && point3.column < 2) {
      point3.column = columnStart[point3.line];
      point3.offset += columnStart[point3.line] - 1;
    }
  }
}
function sliceChunks(chunks, token) {
  const startIndex = token.start._index;
  const startBufferIndex = token.start._bufferIndex;
  const endIndex = token.end._index;
  const endBufferIndex = token.end._bufferIndex;
  let view;
  if (startIndex === endIndex) {
    view = [chunks[startIndex].slice(startBufferIndex, endBufferIndex)];
  } else {
    view = chunks.slice(startIndex, endIndex);
    if (startBufferIndex > -1) {
      const head = view[0];
      if (typeof head === "string") {
        view[0] = head.slice(startBufferIndex);
      } else {
        view.shift();
      }
    }
    if (endBufferIndex > 0) {
      view.push(chunks[endIndex].slice(0, endBufferIndex));
    }
  }
  return view;
}
function serializeChunks(chunks, expandTabs) {
  let index2 = -1;
  const result = [];
  let atTab;
  while (++index2 < chunks.length) {
    const chunk2 = chunks[index2];
    let value;
    if (typeof chunk2 === "string") {
      value = chunk2;
    } else {
      switch (chunk2) {
        case -5: {
          value = "\r";
          break;
        }
        case -4: {
          value = "\n";
          break;
        }
        case -3: {
          value = "\r\n";
          break;
        }
        case -2: {
          value = expandTabs ? " " : "	";
          break;
        }
        case -1: {
          if (!expandTabs && atTab) {
            continue;
          }
          value = " ";
          break;
        }
        default: {
          value = String.fromCharCode(chunk2);
        }
      }
    }
    atTab = chunk2 === -2;
    result.push(value);
  }
  return result.join("");
}

// node_modules/micromark/lib/parse.js
function parse(options) {
  const settings = options || {};
  const constructs2 = (
    /** @type {FullNormalizedExtension} */
    combineExtensions([constructs_exports, ...settings.extensions || []])
  );
  const parser = {
    constructs: constructs2,
    content: create(content),
    defined: [],
    document: create(document2),
    flow: create(flow),
    lazy: {},
    string: create(string),
    text: create(text)
  };
  return parser;
  function create(initial) {
    return creator;
    function creator(from) {
      return createTokenizer(parser, initial, from);
    }
  }
}

// node_modules/micromark/lib/postprocess.js
function postprocess(events) {
  while (!subtokenize(events)) {
  }
  return events;
}

// node_modules/micromark/lib/preprocess.js
var search = /[\0\t\n\r]/g;
function preprocess() {
  let column = 1;
  let buffer = "";
  let start = true;
  let atCarriageReturn;
  return preprocessor;
  function preprocessor(value, encoding, end) {
    value = buffer + (typeof value === "string" ? value.toString() : new TextDecoder(encoding || void 0).decode(value));
    const chunks = [];
    let startPosition = 0;
    buffer = "";
    if (start) {
      if (value.charCodeAt(0) === 65279) {
        startPosition++;
      }
      start = void 0;
    }
    while (startPosition < value.length) {
      search.lastIndex = startPosition;
      const match = search.exec(value);
      const endPosition = match && match.index !== void 0 ? match.index : value.length;
      const code = value.charCodeAt(endPosition);
      if (!match) {
        buffer = value.slice(startPosition);
        break;
      }
      if (code === 10 && startPosition === endPosition && atCarriageReturn) {
        chunks.push(-3);
        atCarriageReturn = void 0;
      } else {
        if (atCarriageReturn) {
          chunks.push(-5);
          atCarriageReturn = void 0;
        }
        if (startPosition < endPosition) {
          chunks.push(value.slice(startPosition, endPosition));
          column += endPosition - startPosition;
        }
        switch (code) {
          case 0: {
            chunks.push(65533);
            column++;
            break;
          }
          case 9: {
            const next = Math.ceil(column / 4) * 4;
            chunks.push(-2);
            while (column++ < next) {
              chunks.push(-1);
            }
            break;
          }
          case 10: {
            chunks.push(-4);
            column = 1;
            break;
          }
          default: {
            atCarriageReturn = true;
            column = 1;
          }
        }
      }
      startPosition = endPosition + 1;
    }
    if (end) {
      if (atCarriageReturn) {
        chunks.push(-5);
      }
      if (buffer) {
        chunks.push(buffer);
      }
      chunks.push(null);
    }
    return chunks;
  }
}

// node_modules/micromark-util-decode-string/index.js
var characterEscapeOrReference = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi;
function decodeString(value) {
  return value.replace(characterEscapeOrReference, decode);
}
function decode($0, $1, $2) {
  if ($1) {
    return $1;
  }
  const head = $2.charCodeAt(0);
  if (head === 35) {
    const head2 = $2.charCodeAt(1);
    const hex = head2 === 120 || head2 === 88;
    return decodeNumericCharacterReference($2.slice(hex ? 2 : 1), hex ? 16 : 10);
  }
  return decodeNamedCharacterReference($2) || $0;
}

// node_modules/unist-util-stringify-position/lib/index.js
function stringifyPosition(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if ("position" in value || "type" in value) {
    return position(value.position);
  }
  if ("start" in value || "end" in value) {
    return position(value);
  }
  if ("line" in value || "column" in value) {
    return point(value);
  }
  return "";
}
function point(point3) {
  return index(point3 && point3.line) + ":" + index(point3 && point3.column);
}
function position(pos) {
  return point(pos && pos.start) + "-" + point(pos && pos.end);
}
function index(value) {
  return value && typeof value === "number" ? value : 1;
}

// node_modules/mdast-util-from-markdown/lib/index.js
var own = {}.hasOwnProperty;
function fromMarkdown(value, encoding, options) {
  if (encoding && typeof encoding === "object") {
    options = encoding;
    encoding = void 0;
  }
  return compiler(options)(postprocess(parse(options).document().write(preprocess()(value, encoding, true))));
}
function compiler(options) {
  const config = {
    afterExit: [],
    beforeEnter: [],
    transforms: [],
    canContainEols: ["emphasis", "fragment", "heading", "paragraph", "strong"],
    enter: {
      autolink: opener(link),
      autolinkProtocol: onenterdata,
      autolinkEmail: onenterdata,
      atxHeading: opener(heading),
      blockQuote: opener(blockQuote2),
      characterEscape: onenterdata,
      characterReference: onenterdata,
      codeFenced: opener(codeFlow),
      codeFencedFenceInfo: buffer,
      codeFencedFenceMeta: buffer,
      codeIndented: opener(codeFlow, buffer),
      codeText: opener(codeText2, buffer),
      codeTextData: onenterdata,
      data: onenterdata,
      codeFlowValue: onenterdata,
      definition: opener(definition2),
      definitionDestinationString: buffer,
      definitionLabelString: buffer,
      definitionTitleString: buffer,
      emphasis: opener(emphasis),
      hardBreakEscape: opener(hardBreak),
      hardBreakTrailing: opener(hardBreak),
      htmlFlow: opener(html, buffer),
      htmlFlowData: onenterdata,
      htmlText: opener(html, buffer),
      htmlTextData: onenterdata,
      image: opener(image),
      label: buffer,
      link: opener(link),
      listItem: opener(listItem),
      listItemValue: onenterlistitemvalue,
      listOrdered: opener(list2, onenterlistordered),
      listUnordered: opener(list2),
      paragraph: opener(paragraph),
      reference: onenterreference,
      referenceString: buffer,
      resourceDestinationString: buffer,
      resourceTitleString: buffer,
      setextHeading: opener(heading),
      strong: opener(strong),
      thematicBreak: opener(thematicBreak2)
    },
    exit: {
      atxHeading: closer(),
      atxHeadingSequence: onexitatxheadingsequence,
      autolink: closer(),
      autolinkEmail: onexitautolinkemail,
      autolinkProtocol: onexitautolinkprotocol,
      blockQuote: closer(),
      characterEscapeValue: onexitdata,
      characterReferenceMarkerHexadecimal: onexitcharacterreferencemarker,
      characterReferenceMarkerNumeric: onexitcharacterreferencemarker,
      characterReferenceValue: onexitcharacterreferencevalue,
      characterReference: onexitcharacterreference,
      codeFenced: closer(onexitcodefenced),
      codeFencedFence: onexitcodefencedfence,
      codeFencedFenceInfo: onexitcodefencedfenceinfo,
      codeFencedFenceMeta: onexitcodefencedfencemeta,
      codeFlowValue: onexitdata,
      codeIndented: closer(onexitcodeindented),
      codeText: closer(onexitcodetext),
      codeTextData: onexitdata,
      data: onexitdata,
      definition: closer(),
      definitionDestinationString: onexitdefinitiondestinationstring,
      definitionLabelString: onexitdefinitionlabelstring,
      definitionTitleString: onexitdefinitiontitlestring,
      emphasis: closer(),
      hardBreakEscape: closer(onexithardbreak),
      hardBreakTrailing: closer(onexithardbreak),
      htmlFlow: closer(onexithtmlflow),
      htmlFlowData: onexitdata,
      htmlText: closer(onexithtmltext),
      htmlTextData: onexitdata,
      image: closer(onexitimage),
      label: onexitlabel,
      labelText: onexitlabeltext,
      lineEnding: onexitlineending,
      link: closer(onexitlink),
      listItem: closer(),
      listOrdered: closer(),
      listUnordered: closer(),
      paragraph: closer(),
      referenceString: onexitreferencestring,
      resourceDestinationString: onexitresourcedestinationstring,
      resourceTitleString: onexitresourcetitlestring,
      resource: onexitresource,
      setextHeading: closer(onexitsetextheading),
      setextHeadingLineSequence: onexitsetextheadinglinesequence,
      setextHeadingText: onexitsetextheadingtext,
      strong: closer(),
      thematicBreak: closer()
    }
  };
  configure(config, (options || {}).mdastExtensions || []);
  const data = {};
  return compile;
  function compile(events) {
    let tree = {
      type: "root",
      children: [],
      position: void 0
    };
    const context = {
      stack: [tree],
      tokenStack: [],
      config,
      enter,
      exit: exit2,
      buffer,
      resume,
      data
    };
    const listStack = [];
    const prepared = [];
    let index2 = -1;
    while (++index2 < events.length) {
      prepared.push(events[index2]);
      if (events[index2][1].type === "listOrdered" || events[index2][1].type === "listUnordered") {
        if (events[index2][0] === "enter") {
          listStack.push(prepared.length - 1);
        } else {
          const tail = listStack.pop();
          prepareList(prepared, tail);
        }
      }
    }
    events = prepared;
    index2 = -1;
    while (++index2 < events.length) {
      const handler = config[events[index2][0]];
      if (events[index2][0] === "enter" && config.beforeEnter.length > 0) {
        callListeners(config.beforeEnter, {
          ...context,
          sliceSerialize: events[index2][2].sliceSerialize
        }, events[index2][1]);
      }
      if (own.call(handler, events[index2][1].type)) {
        handler[events[index2][1].type].call({
          ...context,
          sliceSerialize: events[index2][2].sliceSerialize
        }, events[index2][1]);
      }
      if (events[index2][0] === "exit" && config.afterExit.length > 0) {
        callListeners(config.afterExit, {
          ...context,
          sliceSerialize: events[index2][2].sliceSerialize
        }, events[index2][1]);
      }
    }
    if (context.tokenStack.length > 0) {
      const tail = context.tokenStack[context.tokenStack.length - 1];
      const handler = tail[1] || defaultOnError;
      handler.call(context, void 0, tail[0]);
    }
    tree.position = {
      start: point2(events.length > 0 ? events[0][1].start : {
        line: 1,
        column: 1,
        offset: 0
      }),
      end: point2(events.length > 0 ? events[events.length - 2][1].end : {
        line: 1,
        column: 1,
        offset: 0
      })
    };
    index2 = -1;
    while (++index2 < config.transforms.length) {
      tree = config.transforms[index2](tree) || tree;
    }
    return tree;
  }
  function callListeners(listeners, context, token) {
    let index2 = -1;
    while (++index2 < listeners.length) {
      listeners[index2].call(context, token);
    }
  }
  function prepareList(events, start) {
    const end = events.length - 1;
    let index2 = start - 1;
    let containerBalance = -1;
    let listSpread = false;
    let listItem2;
    let lineIndex;
    let firstBlankLineIndex;
    let atMarker;
    const insertions = [];
    while (++index2 <= end) {
      const event = events[index2];
      switch (event[1].type) {
        case "listUnordered":
        case "listOrdered":
        case "blockQuote": {
          if (event[0] === "enter") {
            containerBalance++;
          } else {
            containerBalance--;
          }
          atMarker = void 0;
          break;
        }
        case "lineEndingBlank": {
          if (event[0] === "enter") {
            if (listItem2 && !atMarker && !containerBalance && !firstBlankLineIndex) {
              firstBlankLineIndex = index2;
            }
            atMarker = void 0;
          }
          break;
        }
        case "linePrefix":
        case "listItemValue":
        case "listItemMarker":
        case "listItemPrefix":
        case "listItemPrefixWhitespace": {
          break;
        }
        default: {
          atMarker = void 0;
        }
      }
      if (!containerBalance && event[0] === "enter" && event[1].type === "listItemPrefix" || containerBalance === -1 && event[0] === "exit" && (event[1].type === "listUnordered" || event[1].type === "listOrdered")) {
        if (listItem2) {
          let tailIndex = index2;
          lineIndex = void 0;
          while (tailIndex--) {
            const tailEvent = events[tailIndex];
            if (tailEvent[1].type === "lineEnding" || tailEvent[1].type === "lineEndingBlank") {
              if (tailEvent[0] === "exit") continue;
              if (lineIndex) {
                events[lineIndex][1].type = "lineEndingBlank";
                listSpread = true;
              }
              tailEvent[1].type = "lineEnding";
              lineIndex = tailIndex;
            } else if (tailEvent[1].type === "linePrefix" || tailEvent[1].type === "blockQuotePrefix" || tailEvent[1].type === "blockQuotePrefixWhitespace" || tailEvent[1].type === "blockQuoteMarker" || tailEvent[1].type === "listItemIndent") {
            } else {
              break;
            }
          }
          if (firstBlankLineIndex && (!lineIndex || firstBlankLineIndex < lineIndex)) {
            listItem2._spread = true;
          }
          listItem2.end = Object.assign({}, lineIndex ? events[lineIndex][1].start : event[1].end);
          insertions.push({
            at: lineIndex || index2,
            event: ["exit", listItem2, event[2]]
          });
        }
        if (event[1].type === "listItemPrefix") {
          const item = {
            type: "listItem",
            _spread: false,
            start: Object.assign({}, event[1].start),
            // @ts-expect-error: we’ll add `end` in a second.
            end: void 0
          };
          listItem2 = item;
          insertions.push({
            at: index2,
            event: ["enter", item, event[2]]
          });
          firstBlankLineIndex = void 0;
          atMarker = true;
        }
      }
    }
    const listEvents = events.splice(start);
    let insertion = 0;
    index2 = -1;
    while (++index2 < listEvents.length) {
      while (insertion < insertions.length && insertions[insertion].at === start + index2) {
        events.push(insertions[insertion++].event);
      }
      events.push(listEvents[index2]);
    }
    events[start][1]._spread = listSpread;
  }
  function opener(create, and) {
    return open;
    function open(token) {
      enter.call(this, create(token), token);
      if (and) and.call(this, token);
    }
  }
  function buffer() {
    this.stack.push({
      type: "fragment",
      children: []
    });
  }
  function enter(node2, token, errorHandler) {
    const parent = this.stack[this.stack.length - 1];
    const siblings = parent.children;
    siblings.push(node2);
    this.stack.push(node2);
    this.tokenStack.push([token, errorHandler || void 0]);
    node2.position = {
      start: point2(token.start),
      // @ts-expect-error: `end` will be patched later.
      end: void 0
    };
  }
  function closer(and) {
    return close;
    function close(token) {
      if (and) and.call(this, token);
      exit2.call(this, token);
    }
  }
  function exit2(token, onExitError) {
    const node2 = this.stack.pop();
    const open = this.tokenStack.pop();
    if (!open) {
      throw new Error("Cannot close `" + token.type + "` (" + stringifyPosition({
        start: token.start,
        end: token.end
      }) + "): it\u2019s not open");
    }
    if (open[0].type !== token.type) {
      if (onExitError) {
        onExitError.call(this, token, open[0]);
      } else {
        const handler = open[1] || defaultOnError;
        handler.call(this, token, open[0]);
      }
    }
    node2.position.end = point2(token.end);
  }
  function resume() {
    return toString(this.stack.pop());
  }
  function onenterlistordered() {
    this.data.expectingFirstListItemValue = true;
  }
  function onenterlistitemvalue(token) {
    if (this.data.expectingFirstListItemValue) {
      const ancestor = this.stack[this.stack.length - 2];
      ancestor.start = Number.parseInt(this.sliceSerialize(token), 10);
      this.data.expectingFirstListItemValue = void 0;
    }
  }
  function onexitcodefencedfenceinfo() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.lang = data2;
  }
  function onexitcodefencedfencemeta() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.meta = data2;
  }
  function onexitcodefencedfence() {
    if (this.data.flowCodeInside) return;
    this.buffer();
    this.data.flowCodeInside = true;
  }
  function onexitcodefenced() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, "");
    this.data.flowCodeInside = void 0;
  }
  function onexitcodeindented() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/(\r?\n|\r)$/g, "");
  }
  function onexitdefinitionlabelstring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
  }
  function onexitdefinitiontitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  function onexitdefinitiondestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  function onexitatxheadingsequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    if (!node2.depth) {
      const depth = this.sliceSerialize(token).length;
      node2.depth = depth;
    }
  }
  function onexitsetextheadingtext() {
    this.data.setextHeadingSlurpLineEnding = true;
  }
  function onexitsetextheadinglinesequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    node2.depth = this.sliceSerialize(token).codePointAt(0) === 61 ? 1 : 2;
  }
  function onexitsetextheading() {
    this.data.setextHeadingSlurpLineEnding = void 0;
  }
  function onenterdata(token) {
    const node2 = this.stack[this.stack.length - 1];
    const siblings = node2.children;
    let tail = siblings[siblings.length - 1];
    if (!tail || tail.type !== "text") {
      tail = text3();
      tail.position = {
        start: point2(token.start),
        // @ts-expect-error: we’ll add `end` later.
        end: void 0
      };
      siblings.push(tail);
    }
    this.stack.push(tail);
  }
  function onexitdata(token) {
    const tail = this.stack.pop();
    tail.value += this.sliceSerialize(token);
    tail.position.end = point2(token.end);
  }
  function onexitlineending(token) {
    const context = this.stack[this.stack.length - 1];
    if (this.data.atHardBreak) {
      const tail = context.children[context.children.length - 1];
      tail.position.end = point2(token.end);
      this.data.atHardBreak = void 0;
      return;
    }
    if (!this.data.setextHeadingSlurpLineEnding && config.canContainEols.includes(context.type)) {
      onenterdata.call(this, token);
      onexitdata.call(this, token);
    }
  }
  function onexithardbreak() {
    this.data.atHardBreak = true;
  }
  function onexithtmlflow() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexithtmltext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexitcodetext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexitlink() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  function onexitimage() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  function onexitlabeltext(token) {
    const string3 = this.sliceSerialize(token);
    const ancestor = this.stack[this.stack.length - 2];
    ancestor.label = decodeString(string3);
    ancestor.identifier = normalizeIdentifier(string3).toLowerCase();
  }
  function onexitlabel() {
    const fragment = this.stack[this.stack.length - 1];
    const value = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    this.data.inReference = true;
    if (node2.type === "link") {
      const children = fragment.children;
      node2.children = children;
    } else {
      node2.alt = value;
    }
  }
  function onexitresourcedestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  function onexitresourcetitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  function onexitresource() {
    this.data.inReference = void 0;
  }
  function onenterreference() {
    this.data.referenceType = "collapsed";
  }
  function onexitreferencestring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
    this.data.referenceType = "full";
  }
  function onexitcharacterreferencemarker(token) {
    this.data.characterReferenceType = token.type;
  }
  function onexitcharacterreferencevalue(token) {
    const data2 = this.sliceSerialize(token);
    const type = this.data.characterReferenceType;
    let value;
    if (type) {
      value = decodeNumericCharacterReference(data2, type === "characterReferenceMarkerNumeric" ? 10 : 16);
      this.data.characterReferenceType = void 0;
    } else {
      const result = decodeNamedCharacterReference(data2);
      value = result;
    }
    const tail = this.stack[this.stack.length - 1];
    tail.value += value;
  }
  function onexitcharacterreference(token) {
    const tail = this.stack.pop();
    tail.position.end = point2(token.end);
  }
  function onexitautolinkprotocol(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = this.sliceSerialize(token);
  }
  function onexitautolinkemail(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = "mailto:" + this.sliceSerialize(token);
  }
  function blockQuote2() {
    return {
      type: "blockquote",
      children: [],
      position: void 0
    };
  }
  function codeFlow() {
    return {
      type: "code",
      lang: null,
      meta: null,
      value: "",
      position: void 0
    };
  }
  function codeText2() {
    return {
      type: "inlineCode",
      value: "",
      position: void 0
    };
  }
  function definition2() {
    return {
      type: "definition",
      identifier: "",
      label: null,
      title: null,
      url: "",
      position: void 0
    };
  }
  function emphasis() {
    return {
      type: "emphasis",
      children: [],
      position: void 0
    };
  }
  function heading() {
    return {
      type: "heading",
      // @ts-expect-error `depth` will be set later.
      depth: 0,
      children: [],
      position: void 0
    };
  }
  function hardBreak() {
    return {
      type: "break",
      position: void 0
    };
  }
  function html() {
    return {
      type: "html",
      value: "",
      position: void 0
    };
  }
  function image() {
    return {
      type: "image",
      title: null,
      url: "",
      alt: null,
      position: void 0
    };
  }
  function link() {
    return {
      type: "link",
      title: null,
      url: "",
      children: [],
      position: void 0
    };
  }
  function list2(token) {
    return {
      type: "list",
      ordered: token.type === "listOrdered",
      start: null,
      spread: token._spread,
      children: [],
      position: void 0
    };
  }
  function listItem(token) {
    return {
      type: "listItem",
      spread: token._spread,
      checked: null,
      children: [],
      position: void 0
    };
  }
  function paragraph() {
    return {
      type: "paragraph",
      children: [],
      position: void 0
    };
  }
  function strong() {
    return {
      type: "strong",
      children: [],
      position: void 0
    };
  }
  function text3() {
    return {
      type: "text",
      value: "",
      position: void 0
    };
  }
  function thematicBreak2() {
    return {
      type: "thematicBreak",
      position: void 0
    };
  }
}
function point2(d) {
  return {
    line: d.line,
    column: d.column,
    offset: d.offset
  };
}
function configure(combined, extensions) {
  let index2 = -1;
  while (++index2 < extensions.length) {
    const value = extensions[index2];
    if (Array.isArray(value)) {
      configure(combined, value);
    } else {
      extension(combined, value);
    }
  }
}
function extension(combined, extension2) {
  let key;
  for (key in extension2) {
    if (own.call(extension2, key)) {
      switch (key) {
        case "canContainEols": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "transforms": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "afterExit":
        case "beforeEnter": {
          const right = extension2[key];
          if (right) {
            combined[key].push(right);
          }
          break;
        }
        case "enter":
        case "exit": {
          const right = extension2[key];
          if (right) {
            Object.assign(combined[key], right);
          }
          break;
        }
      }
    }
  }
}
function defaultOnError(left, right) {
  if (left) {
    throw new Error("Cannot close `" + left.type + "` (" + stringifyPosition({
      start: left.start,
      end: left.end
    }) + "): a different token (`" + right.type + "`, " + stringifyPosition({
      start: right.start,
      end: right.end
    }) + ") is open");
  }
  throw new Error("Cannot close document, a token (`" + right.type + "`, " + stringifyPosition({
    start: right.start,
    end: right.end
  }) + ") is still open");
}

// src/todos.ts
var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const gen = [996825010, 642813549, 513874426, 1027748829, 705979059];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = (chk & 33554431) << 5 ^ value;
    for (let i = 0; i < 5; i += 1) if (top >> i & 1) chk ^= gen[i];
  }
  return chk;
}
function npub(hex) {
  const words2 = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < hex.length; i += 2) {
    acc = (acc << 8 | parseInt(hex.slice(i, i + 2), 16)) & 4095;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words2.push(acc >> bits & 31);
    }
  }
  if (bits > 0) words2.push(acc << 5 - bits & 31);
  const prefix = "npub";
  const expanded = [...[...prefix].map((c) => c.charCodeAt(0) >> 5), 0, ...[...prefix].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...expanded, ...words2, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => mod >> 5 * (5 - i) & 31);
  return `${prefix}1${[...words2, ...checksum].map((w) => CHARSET[w]).join("")}`;
}
function profileTarget(pubkey) {
  return /^[a-f0-9]{64}$/i.test(pubkey) ? `nostr:${npub(pubkey.toLowerCase())}` : void 0;
}
function profileKey(target) {
  const match = /^nostr:(npub1[023456789acdefghjklmnpqrstuvwxyz]{58})$/.exec(target);
  if (!match) return void 0;
  const words2 = [...match[1].slice(5, -6)].map((c) => CHARSET.indexOf(c));
  let acc = 0;
  let bits = 0;
  let hex = "";
  for (const word of words2) {
    acc = (acc << 5 | word) & 4095;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += (acc >> bits & 255).toString(16).padStart(2, "0");
    }
  }
  return hex.length === 64 && profileTarget(hex) === target ? hex : void 0;
}
var marks = { todo: " ", doing: "/", done: "x" };
var assignment = " \xB7 Assignee: ";
function readTodos(content3) {
  const nodes = fromMarkdown(content3).children;
  const headings = nodes.filter(
    (node2) => node2.type === "heading" && node2.depth === 2 && node2.children.length === 1 && node2.children[0]?.type === "text" && node2.children[0].value === "Todos"
  );
  if (headings.length > 1)
    throw new Error(
      "Canvas has more than one Todos section. Keep one ## Todos heading in Canvas before editing here."
    );
  const heading = headings[0];
  const start = heading?.position?.end.offset;
  const following = heading ? nodes.slice(nodes.indexOf(heading) + 1) : [];
  const boundary = following.findIndex(
    (node2) => node2.type === "heading" && node2.depth <= 2
  );
  const section = boundary < 0 ? following : following.slice(0, boundary);
  const items = [];
  function visit(children, parents) {
    for (const item of children) {
      const before = items.length;
      const offset = item.position?.start.offset;
      if (offset === void 0) continue;
      const match = /^([-+*][ \t]+\[)([ xX/])\][ \t]+([^\r\n]+)/.exec(
        content3.slice(offset)
      );
      if (match?.[1] && match[3]) {
        const end = offset + match[0].trimEnd().length;
        const paragraph = item.children[0];
        const link = paragraph?.type === "paragraph" ? paragraph.children.find(
          (child) => child.type === "link" && child.position?.end.offset === end
        ) : void 0;
        const linkStart = link?.position?.start.offset;
        const linkEnd = link?.position?.end.offset;
        const pubkey = link?.type === "link" ? profileKey(link.url) : void 0;
        const name = link?.type === "link" && link.children.length === 1 && link.children[0]?.type === "text" ? link.children[0].value : void 0;
        const assignee = pubkey && name && linkStart !== void 0 && linkEnd === end && link?.type === "link" && !link.title && content3.slice(linkStart, linkEnd).endsWith(`](${profileTarget(pubkey)})`) && content3.slice(linkStart - assignment.length, linkStart) === assignment ? { pubkey, name, start: linkStart - assignment.length } : void 0;
        const named = assignee ? null : / · Assignee: ([\p{L}\p{N}][\p{L}\p{N} .’'_-]*)$/u.exec(
          content3.slice(offset, end)
        );
        const namedText = paragraph?.type === "paragraph" && paragraph.children.some(
          (child) => child.type === "text" && (child.position?.start.offset ?? Infinity) <= offset + (named?.index ?? 0) && (child.position?.end.offset ?? -1) >= end
        );
        const namedAssignee = named?.[1] && namedText ? { name: named[1].trim(), start: offset + named.index } : void 0;
        items.push({
          offset: offset + match[1].length,
          label: content3.slice(
            offset + match[0].length - match[3].length,
            assignee?.start ?? namedAssignee?.start ?? end
          ).trim(),
          status: match[2] === " " ? "todo" : match[2] === "/" ? "doing" : "done",
          end,
          assignee,
          ...namedAssignee ? { namedAssignee } : {},
          parents
        });
      }
      const todo = items.length > before ? items[items.length - 1] : void 0;
      for (const child of item.children)
        if (child.type === "list" && !child.ordered)
          visit(child.children, todo ? [...parents, todo.label] : parents);
    }
  }
  for (const node2 of section)
    if (node2.type === "list" && !node2.ordered) visit(node2.children, []);
  return { items, start };
}
function setStatus(content3, offset, status) {
  if (!readTodos(content3).items.some((item) => item.offset === offset))
    throw new Error("This todo changed. Reload the Canvas before editing it.");
  return content3.slice(0, offset) + marks[status] + content3.slice(offset + 1);
}
function addTodo(content3, label) {
  const text3 = label.trim();
  if (!text3 || /[\r\n]/.test(text3))
    throw new Error("Use a single line for your todo.");
  const { start, items } = readTodos(content3);
  const newline = content3.includes("\r\n") ? "\r\n" : "\n";
  const line2 = `- [ ] ${text3}`;
  const next = start === void 0 ? `${content3}${content3 ? newline + newline : ""}## Todos${newline}${newline}${line2}${newline}` : `${content3.slice(0, start)}${newline}${newline}${line2}${newline}${content3.slice(start)}`;
  if (readTodos(next).items.length !== items.length + 1)
    throw new Error(
      "Could not add a todo safely. Check Canvas for unfinished Markdown blocks."
    );
  return next;
}
function assignTodo(content3, offset, assignee) {
  const { items } = readTodos(content3);
  const item = items.find((item2) => item2.offset === offset);
  if (!item)
    throw new Error("This todo changed. Reload the Canvas before editing it.");
  const target = assignee && profileTarget(assignee.pubkey);
  if (assignee && !target) throw new Error("Choose a valid Buzz user.");
  const name = assignee?.name.replace(/\s+/g, " ").trim() || assignee?.pubkey || "";
  const escaped = name.replace(/[\\`*_{}[\]()#+\-.!<>|&]/g, "\\$&");
  const suffix = assignee ? `${assignment}[${escaped}](${target})` : "";
  const start = item.assignee?.start ?? item.namedAssignee?.start ?? item.end;
  const next = content3.slice(0, start) + suffix + content3.slice(item.end);
  const parsed = readTodos(next);
  const edited = parsed.items.find((value) => value.offset === offset);
  if (parsed.items.length !== items.length || edited?.label !== item.label || edited?.assignee?.pubkey !== assignee?.pubkey.toLowerCase())
    throw new Error(
      "Could not assign safely. Check this todo\u2019s Markdown in Canvas."
    );
  return next;
}
var FILLER = /* @__PURE__ */ new Set(["the", "a", "an", "to", "todo", "todos", "item", "task", "one", "about", "for", "on", "in", "of", "and", "that", "this", "it", "list", "mark", "as", "is"]);
function words(text3) {
  return text3.toLowerCase().replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1 && !FILLER.has(word));
}
function findTodo(items, phrase, prefer) {
  const wanted = words(phrase);
  if (wanted.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const have = new Set(words(item.label));
    const hits2 = wanted.filter((word) => have.has(word) || [...have].some((h) => h.length > 3 && (h.startsWith(word) || word.startsWith(h)))).length;
    const score2 = hits2 / wanted.length + (prefer?.(item) ? 0.01 : 0);
    if (score2 > bestScore) {
      best = item;
      bestScore = score2;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

// src/types.ts
function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}
function rootOf(event) {
  const marked = event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1];
  return marked ?? event.tags.find((tag) => tag[0] === "e" && tag[1])?.[1] ?? event.id;
}
function plain(text3) {
  return text3.replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/nostr:\S+/g, "").replace(/[*_~`]+/g, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
}

// src/scope.ts
function emptyScope() {
  return { channel: null, threads: [], focus: null };
}
function describeThread(thread, names) {
  const root = thread.messages[0];
  const label = plain(root?.content ?? "").slice(0, 70);
  const who = [
    ...new Set(thread.messages.map((m) => names.get(m.pubkey) ?? m.pubkey.slice(0, 8)))
  ].slice(0, 4);
  return {
    rootId: thread.rootId,
    channelId: "",
    channelName: "",
    label: label || thread.rootId.slice(0, 8),
    who,
    lastAt: thread.lastAt
  };
}
function setThreads(scope, channel, threads, focus) {
  const owned = threads.map((t) => ({ ...t, channelId: channel.id, channelName: channel.name }));
  const picked = focus ? owned.find((t) => t.rootId === focus.rootId) ?? null : null;
  return { channel, threads: owned, focus: picked ?? owned[owned.length - 1] ?? null };
}
function rememberPost(scope, channel, thread) {
  const owned = { ...thread, channelId: channel.id, channelName: channel.name };
  const same = scope.channel?.id === channel.id;
  const rest = (same ? scope.threads : []).filter((t) => t.rootId !== owned.rootId);
  return { channel, threads: [...rest, owned], focus: owned };
}
function setItems(channel, threads, focus) {
  return { channel, threads, focus };
}
function threadByRef(scope, ref) {
  if (ref === null) return null;
  return scope.threads[ref - 1] ?? null;
}
function resolveThread(scope, channel, ref) {
  if (ref !== null) {
    const picked = threadByRef(scope, ref);
    return picked && picked.channelId === channel.id ? picked : null;
  }
  return scope.focus && scope.focus.channelId === channel.id ? scope.focus : null;
}
function scopeLabel(scope) {
  if (!scope.focus) return scope.channel?.name ?? "";
  const index2 = scope.threads.findIndex((t) => t.rootId === scope.focus?.rootId);
  const number = index2 >= 0 ? `${index2 + 1}` : "?";
  const where = scope.focus.channelName || scope.channel?.name || "";
  return `${where} \xB7 thread ${number}: ${scope.focus.label}`;
}

// src/controller.ts
var HISTORY_TURNS = 12;
var INBOX_DAYS = 3;
var WATCH_HOURS = 8;
var MAX_WATCHES = 12;
var POLL_MS = 15e3;
var MAX_LOG = 200;
var WATCH_KEY = "buzz-voice-plugin.watches";
var TRACK_KEY = "buzz-voice-plugin.threads";
var FOLLOW_UP_MS = 12e3;
var YES = /\b(yes|yep|yeah|send it|do it|go ahead|confirm|sure)\b/i;
var NO = /\b(no|nope|cancel|stop|never ?mind|don'?t)\b/i;
var NOISE = /^\W*(?:thank you|thanks|you|bye|okay|ok|uh|um|hmm|mm|oh|so|yeah)\W*$/i;
var OP_STATUS = { start: "doing", done: "done", reopen: "todo" };
var STATE_EMOJI = {
  working: "\u{1F504}",
  stalled: "\u26D4",
  done: "\u2705",
  "needs-input": "\u{1F440}"
};
var EMOJI_STATE = new Map(
  Object.entries(STATE_EMOJI).map(([state, emoji]) => [emoji, state])
);
function now() {
  return Math.floor(Date.now() / 1e3);
}
function escapeRe(text3) {
  return text3.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function mentionsIn(body, members) {
  return members.filter((member) => new RegExp(`@${escapeRe(member.name)}(?![\\w-])`, "i").test(body));
}
function block(thread, index2, names) {
  const lines = thread.messages.slice(-12).map((event) => {
    const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
    const when = new Date(event.created_at * 1e3).toLocaleString();
    return `  ${who} (${when}): ${event.content.replace(/\s+/g, " ").slice(0, 600)}`;
  });
  return [`Thread ${index2 + 1}:`, ...lines].join("\n");
}
function spoken(who, channelName, content3) {
  const body = content3.replace(/```[\s\S]*?```/g, " a code block ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " a link ").replace(/nostr:\S+/g, " ").replace(/^@\S+\s*/, "").replace(/[*_~`#>|]+/g, "").replace(/\s+/g, " ").trim();
  const cut = body.length > 420 ? `${body.slice(0, 420).replace(/\s\S*$/, "")}...` : body;
  return `${who} in ${channelName}. ${cut}`;
}
var Controller = class {
  constructor(deps) {
    this.deps = deps;
    this.speaker = new Speaker(deps.host, () => this.state.settings);
    this.listener = new Listener(deps.host);
    this.listener.onHeard = (heard) => this.heard(heard);
    this.listener.onExit = () => {
      if (this.wantHandsFree) void this.dropHandsFree("Speech recognition stopped. Turn hands-free on to restart it.");
    };
    this.recorder.onLost = () => {
      if (this.wantHandsFree) void this.dropHandsFree("The microphone disconnected.");
    };
    this.speaker.onIdle = () => {
      if (!this.state.handsFree) return;
      this.listener.reset();
      this.wake(FOLLOW_UP_MS);
    };
    const watches = loadJson(WATCH_KEY, []).filter((w) => w.until > now());
    this.state = {
      ready: false,
      listening: false,
      opening: false,
      latched: false,
      transcribing: false,
      busy: false,
      level: 0,
      status: "",
      statusBad: false,
      log: [],
      pending: null,
      scope: "",
      watches,
      engine: null,
      engineError: "",
      installing: "",
      settings: loadSettings(),
      routing: "",
      handsFree: false,
      hearing: false,
      awake: false
    };
  }
  state;
  listeners = /* @__PURE__ */ new Set();
  recorder = new Recorder();
  speaker;
  scope = emptyScope();
  history = [];
  turn = 0;
  nextId = 1;
  awaitingYesNo = false;
  tracked = loadJson(TRACK_KEY, []);
  timer = null;
  polling = false;
  levelFrame = 0;
  stopWhenOpen = false;
  listener;
  awakeUntil = 0;
  wantHandsFree = false;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;
  set(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  start() {
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    void this.refreshEngine().then(() => {
      if (this.state.settings.handsFree) void this.setHandsFree(true);
    });
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.recorder.release();
      this.listener.stop();
      this.speaker.stop();
    };
  }
  llm() {
    const settings = this.state.settings;
    if (!settings.llmUrl) return null;
    return { model: settings.llmModel || "default", post: llmPoster(this.deps.host, settings) };
  }
  updateSettings(patch) {
    const settings = { ...this.state.settings, ...patch };
    const restart = patch.modelDir !== void 0 && patch.modelDir !== this.state.settings.modelDir || patch.whisper !== void 0 && patch.whisper !== this.state.settings.whisper;
    const micChanged = patch.microphone !== void 0 && patch.microphone !== this.state.settings.microphone;
    saveSettings(settings);
    this.set({ settings });
    if (restart) this.listener.stop();
    if (micChanged) this.recorder.release();
    if ((restart || micChanged) && this.wantHandsFree) void this.setHandsFree(true);
  }
  async dropHandsFree(reason) {
    await this.setHandsFree(false, false);
    this.setStatus(reason, true);
  }
  async warmListener() {
    if (!this.state.engine?.runtime || !this.state.ready) return false;
    try {
      return await this.listener.ensure(this.state.settings);
    } catch {
      return false;
    }
  }
  async setHandsFree(on, remember = true) {
    this.wantHandsFree = on;
    if (!on) {
      await this.recorder.listen(null);
      this.listener.reset();
      this.set({ handsFree: false, hearing: false, awake: false, opening: false });
      if (remember && this.state.settings.handsFree) this.updateSettings({ handsFree: false });
      return;
    }
    if (!this.state.ready || !this.state.engine?.runtime) {
      this.wantHandsFree = false;
      this.setStatus(
        this.state.ready ? "Hands-free needs the fast speech runtime. Install it in Settings." : "Install the speech engine in Settings first.",
        true
      );
      return;
    }
    this.set({ opening: true, status: "Starting hands-free...", statusBad: false });
    try {
      const started = await this.warmListener();
      if (!this.wantHandsFree) return;
      if (!started) throw new Error("The speech runtime did not start.");
      await this.recorder.listen((pcm) => {
        if (this.speaker.speaking || this.state.listening) return;
        this.listener.feed(pcmBase64(pcm));
      }, this.state.settings.microphone);
      if (!this.wantHandsFree) {
        await this.recorder.listen(null);
        return;
      }
      this.listener.reset();
      this.set({ handsFree: true, opening: false, status: `Hands-free. Say \u201Chey ${this.wakeWord()}\u201D.`, statusBad: false });
      if (!this.state.settings.handsFree) this.updateSettings({ handsFree: true });
    } catch (error) {
      if (!this.wantHandsFree) return;
      this.wantHandsFree = false;
      await this.recorder.listen(null);
      this.set({ handsFree: false, opening: false });
      this.setStatus(`Hands-free: ${message(error)}`, true);
    }
  }
  toggleHandsFree() {
    void this.setHandsFree(!this.wantHandsFree);
  }
  wakeWord() {
    return this.state.settings.wakeWord.trim() || "buzz";
  }
  wake(ms) {
    this.awakeUntil = Date.now() + ms;
    this.set({ awake: true });
    setTimeout(() => {
      if (Date.now() >= this.awakeUntil && this.state.awake) this.set({ awake: false });
    }, ms + 50);
  }
  /** The command after the wake word, "" when only the wake word was said, null when it was not said. */
  afterWake(text3) {
    const word = this.wakeWord().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sounds = word === "buzz" ? "buzz|bus|buz|buzzed|bugs" : word;
    const match = new RegExp(`^\\W*(?:(?:hey|hi|ok|okay|a)[\\s,]+)?(?:${sounds})\\b[\\s,.!?:;-]*`, "i").exec(text3);
    return match ? text3.slice(match[0].length).trim() : null;
  }
  heard(heard) {
    if (!this.state.handsFree) return;
    if (heard.kind === "speech") {
      this.set({ hearing: heard.active });
      return;
    }
    if (heard.kind === "error") {
      this.setStatus(`Speech: ${heard.message}`, true);
      return;
    }
    const text3 = heard.text;
    if (!text3 || /^\[?(blank_audio|silence|music|noise)\]?$/i.test(text3) || /^[\W_]*$/.test(text3)) return;
    const command = this.afterWake(text3);
    if (command === null) {
      if (Date.now() >= this.awakeUntil || NOISE.test(text3)) return;
      if (this.awaitingYesNo && this.state.pending) {
        if (!NO.test(text3) && !YES.test(text3)) return;
      } else if (text3.split(/\s+/).length < 3) return;
    }
    if (command === "") {
      this.speaker.stop();
      this.wake(FOLLOW_UP_MS);
      this.setStatus("Listening...");
      return;
    }
    this.awakeUntil = 0;
    this.set({ awake: false });
    void this.handleTranscript(command ?? text3);
  }
  async refreshEngine() {
    try {
      const engine = await checkEngine(this.deps.host, this.state.settings);
      this.set({ engine, engineError: "", ready: engine.engine && engine.model });
      this.adoptBuzzVoice(engine);
    } catch (error) {
      this.set({ engine: null, engineError: message(error), ready: false });
    }
  }
  adoptBuzzVoice(engine) {
    const saved = engine.buzzVoice;
    const settings = this.state.settings;
    if (!saved || settings.llmUrl) return;
    const url = typeof saved.llm_url === "string" ? saved.llm_url : "";
    const model = typeof saved.llm_model === "string" ? saved.llm_model : "";
    if (url) this.updateSettings({ llmUrl: url, llmModel: settings.llmModel || model });
  }
  async install() {
    this.set({ installing: "Starting", engineError: "" });
    try {
      const engine = await installEngine(
        this.deps.host,
        this.state.settings,
        (step) => this.set({ installing: step === "engine" ? "Downloading the speech engine" : "Downloading the whisper model" })
      );
      this.set({ engine, installing: "", ready: engine.engine && engine.model });
    } catch (error) {
      this.set({ installing: "", engineError: message(error) });
    }
  }
  setStatus(status, bad = false) {
    this.set({ status, statusBad: bad });
  }
  say(role, text3, extra = {}) {
    const entry = { id: this.nextId++, role, text: text3, ...extra };
    this.set({ log: [...this.state.log, entry].slice(-MAX_LOG) });
    this.history.push({ role, text: text3 });
    if (this.history.length > HISTORY_TURNS) this.history.splice(0, this.history.length - HISTORY_TURNS);
  }
  reply(text3, opts = {}) {
    this.say("app", text3, { bad: opts.bad });
    this.setStatus(opts.bad ? text3 : "", opts.bad);
    this.speaker.speak(text3);
  }
  newSession() {
    this.turn += 1;
    this.scope = emptyScope();
    this.history = [];
    this.awaitingYesNo = false;
    this.set({ log: [], pending: null, scope: "", busy: false, status: "" });
  }
  stopSpeaking() {
    this.speaker.stop();
  }
  async startListening() {
    if (this.state.listening || this.state.transcribing) return;
    if (!this.state.ready) {
      this.setStatus("Install the speech engine in Settings first.", true);
      return;
    }
    if (this.state.opening) return;
    this.speaker.stop();
    this.stopWhenOpen = false;
    if (!this.recorder.open) this.set({ opening: true, status: "Opening the microphone...", statusBad: false });
    try {
      await this.recorder.start((level) => {
        if (this.levelFrame) return;
        this.levelFrame = requestAnimationFrame(() => {
          this.levelFrame = 0;
          this.set({ level });
        });
      }, this.state.settings.microphone);
      this.set({ opening: false, listening: true, latched: false, status: "Listening...", statusBad: false });
      if (this.stopWhenOpen) await this.stopListening();
    } catch (error) {
      this.set({ opening: false });
      this.setStatus(`Microphone: ${message(error)}`, true);
    }
  }
  warmMicrophone() {
    if (!this.state.ready || this.recorder.open) return;
    void this.recorder.warm(this.state.settings.microphone).catch((error) => {
      this.setStatus(`Microphone: ${message(error)}`, true);
    });
  }
  latch() {
    if (this.state.listening) this.set({ latched: true });
  }
  async toggleListening() {
    if (this.state.listening) return this.stopListening();
    await this.startListening();
    this.latch();
  }
  async stopListening() {
    if (this.state.opening) {
      this.stopWhenOpen = true;
      return;
    }
    if (!this.state.listening) return;
    const audio = await this.recorder.stop();
    this.set({ listening: false, latched: false, level: 0, transcribing: true, status: "Transcribing..." });
    try {
      if (!audio || audio.seconds < 0.3 || audio.peak < 0.01) {
        this.setStatus("I did not hear anything.");
        return;
      }
      const text3 = await this.warmListener() ? await this.listener.decode(audio.pcm) : await transcribe(this.deps.host, this.state.settings, audio.base64);
      if (!text3 || /^\[?(blank_audio|silence)\]?$/i.test(text3)) {
        this.setStatus("I did not catch that.");
        return;
      }
      this.setStatus("");
      await this.handleTranscript(text3);
    } catch (error) {
      this.setStatus(message(error), true);
    } finally {
      this.set({ transcribing: false });
    }
  }
  cancelListening() {
    this.recorder.cancel();
    this.set({ listening: false, latched: false, level: 0, status: "" });
  }
  submitText(text3) {
    const trimmed = text3.trim();
    if (trimmed) void this.handleTranscript(trimmed);
  }
  channels() {
    return this.deps.relay()?.channels() ?? [];
  }
  async people(relay, channels) {
    const ids = /* @__PURE__ */ new Set();
    for (const channel of channels) for (const id of channel.members ?? []) if (id !== relay.pubkey) ids.add(id);
    const names = await relay.profiles([...ids].slice(0, 400));
    return [...new Set(names.values())].filter(Boolean).sort();
  }
  async handleTranscript(text3) {
    this.say("you", text3);
    const relay = this.deps.relay();
    if (!relay) {
      this.reply("Buzz is not connected yet.", { bad: true });
      return;
    }
    if (this.awaitingYesNo && this.state.pending) {
      this.awaitingYesNo = false;
      if (NO.test(text3)) this.cancel();
      else if (YES.test(text3)) await this.publish();
      else {
        this.cancel();
        await this.route(relay, text3);
      }
      return;
    }
    await this.route(relay, text3);
  }
  async route(relay, text3) {
    const ticket = ++this.turn;
    const live = () => ticket === this.turn;
    this.set({ busy: true });
    try {
      this.setStatus("Working out what you meant...");
      const channels = this.channels();
      const people = await this.people(relay, channels);
      const decide = this.deps.decide();
      const llm = this.llm();
      const intent = await parseIntent({
        llm,
        decide,
        community: this.deps.community(),
        transcript: text3,
        channels,
        people,
        scope: this.scope,
        turns: this.history.slice(0, -1)
      });
      if (!live()) return;
      if (intent.action === "inbox") return await this.readInbox(relay, text3);
      const named = matchChannel(channels, intent.channel, text3);
      const referenced = threadByRef(this.scope, intent.thread_ref);
      const byRef = referenced ? channels.find((c) => c.id === referenced.channelId) ?? null : null;
      const staying = intent.continues_previous || intent.thread === "existing";
      const channel = named ?? byRef ?? (staying ? this.scope.channel : null);
      if (intent.action === "todo") {
        const home = channel ?? matchChannel(channels, null, text3);
        if (!home) {
          this.reply(intent.channel ? `There is no channel called ${intent.channel}.` : "Which channel's todo list?", { bad: true });
          return;
        }
        return await this.planTodo(relay, home, intent, text3, live);
      }
      if (intent.action === "status") {
        if (channel) {
          const target2 = named && named.id !== this.scope.channel?.id ? null : resolveThread(this.scope, channel, intent.thread_ref);
          if (target2 && (intent.thread === "existing" || intent.thread_ref !== null)) {
            return await this.readThread(relay, channel, target2, text3);
          }
          return await this.readChannel(relay, channel, text3);
        }
        await this.refreshTracked(relay);
        if (!live()) return;
        this.reply(this.summarizeTracked(intent.filter));
        return;
      }
      if (!channel) {
        this.reply(
          intent.channel ? `There is no channel called ${intent.channel}.` : "I did not catch a channel in that.",
          { bad: true }
        );
        return;
      }
      if (intent.action !== "post" || !intent.instruction.trim()) {
        this.reply(`I heard ${channel.name} but no task in that.`, { bad: true });
        return;
      }
      const target = intent.new_thread ? null : resolveThread(this.scope, channel, intent.thread_ref) ?? await this.findThread(relay, channel, intent, text3);
      if (!live()) return;
      const members = await this.rankedMembers(relay, channel, target?.rootId ?? null);
      if (!live()) return;
      const mention = intent.recipient ? bestPerson(members, (m) => m.name, intent.recipient, text3) : null;
      const addressed = mention?.name ?? intent.recipient;
      const body = addressed ? `@${addressed} ${intent.instruction}` : intent.instruction;
      this.set({
        pending: {
          todo: null,
          channel,
          replyTo: target?.rootId ?? null,
          label: target?.label ?? null,
          orphaned: !intent.new_thread && !target,
          body,
          addressed,
          members
        }
      });
      this.setStatus("Edit it if you need to, then send. Or say yes.");
      this.speaker.speak(intent.spoken_confirmation || `Send to ${channel.name}?`);
      this.awaitingYesNo = true;
    } catch (error) {
      if (live()) this.reply(message(error), { bad: true });
    } finally {
      if (live()) this.set({ busy: false });
    }
  }
  async planTodo(relay, channel, intent, text3, live) {
    this.setStatus(`Reading the todos in ${channel.name}...`);
    const head = await relay.readCanvas(channel.id);
    if (!live()) return;
    const items = readTodos(head?.content ?? "").items;
    if (intent.todo_op === "list") return this.readTodoList(channel, items);
    const phrase = intent.instruction.trim().replace(/[.!?]+$/, "");
    if (!phrase) {
      this.reply(`I heard the ${channel.name} todos but not which one.`, { bad: true });
      return;
    }
    let existing = null;
    if (intent.todo_op !== "add") {
      const status = intent.todo_op === "assign" ? null : OP_STATUS[intent.todo_op];
      existing = findTodo(items, phrase, status ? (item) => item.status !== status : void 0);
      if (!existing) {
        this.reply(`No todo in ${channel.name} matches \u201C${phrase}\u201D.`, { bad: true });
        return;
      }
    }
    const scoped = intent.new_thread ? null : resolveThread(this.scope, channel, intent.thread_ref);
    const target = scoped ?? (intent.thread_hint ? await this.findThread(relay, channel, intent, text3) : null);
    if (!live()) return;
    const members = await this.rankedMembers(relay, channel, target?.rootId ?? null);
    if (!live()) return;
    const assignee = intent.recipient ? bestPerson(members, (m) => m.name, intent.recipient, text3) : null;
    if (intent.recipient && !assignee) {
      this.reply(`Nobody called ${intent.recipient} is in ${channel.name}.`, { bad: true });
      return;
    }
    if (intent.todo_op === "assign" && !assignee) {
      this.reply("Who should I assign it to?", { bad: true });
      return;
    }
    const label = existing?.label ?? phrase.charAt(0).toUpperCase() + phrase.slice(1);
    const op = intent.todo_op;
    const body = assignee && (op === "add" || op === "assign") ? `@${assignee.name} ${label}` : "";
    this.set({
      pending: {
        todo: { op, label, offset: existing?.offset ?? null, assignee },
        channel,
        replyTo: target?.rootId ?? null,
        label: target?.label ?? null,
        orphaned: false,
        body,
        addressed: assignee?.name ?? null,
        members
      }
    });
    const verb = { add: "Add", assign: "Assign", start: "Start", done: "Finish", reopen: "Reopen" }[op];
    const who = assignee && (op === "add" || op === "assign") ? ` for ${assignee.name}` : "";
    this.setStatus("Edit it if you need to, then confirm. Or say yes.");
    this.speaker.speak(`${verb} ${plain(label)}${who} in ${channel.name}?`);
    this.awaitingYesNo = true;
  }
  readTodoList(channel, items) {
    const open = items.filter((item) => item.status !== "done");
    if (items.length === 0) return this.reply(`${channel.name} has no todos.`);
    if (open.length === 0) return this.reply(`Everything on the ${channel.name} list is done.`);
    const lines = open.slice(0, 6).map((item) => {
      const who = item.assignee?.name ?? item.namedAssignee?.name;
      return `${plain(item.label)}${who ? `, ${who}` : ""}${item.status === "doing" ? ", in progress" : ""}.`;
    });
    const more = open.length > 6 ? ` And ${open.length - 6} more.` : "";
    this.reply(`${open.length} open in ${channel.name}. ${lines.join(" ")}${more}`);
  }
  editTodoLabel(label) {
    const pending = this.state.pending;
    if (!pending?.todo || pending.todo.op !== "add") return;
    const body = pending.todo.assignee ? `@${pending.todo.assignee.name} ${label}` : "";
    this.set({ pending: { ...pending, todo: { ...pending.todo, label }, body: pending.body ? body : "" } });
  }
  assignPending(member) {
    const pending = this.state.pending;
    if (!pending?.todo) return;
    const body = member ? `@${member.name} ${pending.todo.label}` : "";
    this.set({ pending: { ...pending, todo: { ...pending.todo, assignee: member }, body, addressed: member?.name ?? null } });
  }
  async publishTodo(relay, pending) {
    const todo = pending.todo;
    const { channel, replyTo } = pending;
    const label = todo.op === "add" ? todo.label.replace(/\s+/g, " ").trim() : todo.label;
    if (!label) return;
    this.setStatus(`Updating the ${channel.name} todos...`);
    await relay.editCanvas(channel.id, (content3) => {
      if (todo.op === "add") {
        const next = addTodo(content3, label);
        if (!todo.assignee) return next;
        const added = readTodos(next).items.find((item2) => item2.label === label && !item2.assignee && !item2.namedAssignee);
        if (!added) throw new Error("Could not find the new todo to assign it.");
        return assignTodo(next, added.offset, todo.assignee);
      }
      const items = readTodos(content3).items;
      const same = items.filter((i) => i.label === label);
      const item = same.find((i) => i.offset === todo.offset) ?? (same.length === 1 ? same[0] : void 0);
      if (!item) throw new Error(`\u201C${label}\u201D is no longer on the ${channel.name} list.`);
      if (todo.op === "assign") return assignTodo(content3, item.offset, todo.assignee ?? void 0);
      return setStatus(content3, item.offset, OP_STATUS[todo.op]);
    });
    const done = { add: "Added", assign: "Assigned", start: "Started", done: "Done", reopen: "Reopened" }[todo.op];
    const body = pending.body.trim();
    const mentioned = mentionsIn(body, pending.members);
    if (!body || mentioned.length === 0) {
      this.say("app", label, { meta: `${done} in ${channel.name} todos` });
      this.setStatus("");
      this.speaker.speak(`${done}.`);
      return;
    }
    const event = relay.postMessage({
      channelId: channel.id,
      content: body,
      mentions: mentioned.map((m) => m.pubkey),
      replyTo: replyTo ?? void 0
    });
    const rootId = replyTo ?? event.id;
    this.watch({ rootId, channelId: channel.id, channelName: channel.name, label: body, since: event.created_at });
    this.say("app", body, {
      meta: `${done} in ${channel.name} todos, told ${mentioned.map((m) => m.name).join(", ")}`,
      link: { channelId: channel.id, messageId: event.id, rootId }
    });
    this.setStatus(`${done}. Watching for a reply.`);
    this.speaker.speak(`${done}, and told ${mentioned[0].name}.`);
  }
  async rankedMembers(relay, channel, rootId) {
    const [roster, recent, thread] = await Promise.all([
      relay.members(channel).catch(() => []),
      relay.threads(channel.id, 120).catch(() => []),
      rootId ? Promise.all([relay.byIds([rootId]), relay.messagesInThread(channel.id, rootId)]).then(([root, replies]) => [...root, ...replies]).catch(() => []) : Promise.resolve([])
    ]);
    const lastSeen = (events) => {
      const at = /* @__PURE__ */ new Map();
      for (const event of events) {
        if (event.pubkey === relay.pubkey) continue;
        at.set(event.pubkey, Math.max(at.get(event.pubkey) ?? 0, event.created_at));
      }
      return [...at.entries()].sort((a, b) => b[1] - a[1]).map(([pubkey]) => pubkey);
    };
    const order = [
      ...lastSeen(thread),
      ...lastSeen(recent.flatMap((t) => t.messages)),
      ...roster.map((m) => m.pubkey)
    ];
    const unique = [...new Set(order)];
    const names = await relay.profiles(unique.filter((pubkey) => !roster.some((m) => m.pubkey === pubkey)));
    for (const member of roster) names.set(member.pubkey, member.name);
    return unique.map((pubkey) => ({ pubkey, name: names.get(pubkey) ?? "" })).filter((m) => m.name);
  }
  async findThread(relay, channel, intent, transcript) {
    this.setStatus(`Finding the thread in ${channel.name}...`);
    const all2 = await relay.threads(channel.id);
    if (all2.length === 0) return null;
    const recent = all2.slice(-12);
    const names = await relay.profiles([...new Set(recent.flatMap((t) => t.messages.map((m) => m.pubkey)))]);
    const owned = recent.map((thread) => describeThread(thread, names)).map((t) => ({ ...t, channelId: channel.id, channelName: channel.name }));
    const newest = owned[owned.length - 1];
    if (!intent.thread_hint) return newest;
    const ref = await pickThread({
      llm: this.llm(),
      decide: this.deps.decide(),
      community: this.deps.community(),
      channelName: channel.name,
      hint: intent.thread_hint,
      transcript,
      labels: owned.map((t) => t.label)
    }).catch(() => null);
    return ref === null ? newest : owned[ref - 1];
  }
  requireLlm() {
    const llm = this.llm();
    if (!llm) throw new Error("Reading back needs an LLM. Add one in Buzz Voice settings.");
    return llm;
  }
  paintScope() {
    this.set({ scope: scopeLabel(this.scope) });
  }
  async readChannel(relay, channel, question) {
    this.setStatus(`Reading ${channel.name}...`);
    const all2 = await relay.threads(channel.id);
    if (all2.length === 0) {
      this.scope = setThreads(this.scope, channel, [], null);
      this.paintScope();
      this.reply(`${channel.name} has no messages.`);
      return;
    }
    const recent = all2.slice(-8);
    const names = await relay.profiles([...new Set(recent.flatMap((t) => t.messages.map((m) => m.pubkey)))]);
    const blocks = recent.map((thread, index2) => block(thread, index2, names));
    const described = recent.map((thread) => describeThread(thread, names));
    const answer = await summarizeChannel(this.requireLlm(), channel.name, question, blocks);
    const picked = answer.thread ? described[answer.thread - 1] ?? null : null;
    this.scope = setThreads(this.scope, channel, described, picked);
    this.paintScope();
    this.reply(answer.answer);
  }
  async readThread(relay, channel, thread, question) {
    this.setStatus(`Reading that thread in ${channel.name}...`);
    const [root, replies] = await Promise.all([
      relay.byIds([thread.rootId]),
      relay.messagesInThread(channel.id, thread.rootId)
    ]);
    const messages = [...root, ...replies].filter((event, index2, list2) => list2.findIndex((e) => e.id === event.id) === index2).sort((a, b) => a.created_at - b.created_at);
    if (messages.length === 0) return this.readChannel(relay, channel, question);
    const names = await relay.profiles([...new Set(messages.map((m) => m.pubkey))]);
    const one2 = {
      rootId: thread.rootId,
      messages: messages.slice(-24),
      lastAt: messages[messages.length - 1].created_at
    };
    const answer = await summarizeChannel(this.requireLlm(), channel.name, question, [block(one2, 0, names)]);
    this.scope = { ...this.scope, channel, focus: thread };
    this.paintScope();
    this.watch({ rootId: thread.rootId, channelId: channel.id, channelName: channel.name, label: thread.label, since: one2.lastAt });
    this.reply(answer.answer);
  }
  async readInbox(relay, question) {
    this.setStatus("Checking your inbox...");
    const since = now() - INBOX_DAYS * 86400;
    const mentions = await relay.mentions(since);
    const byRoot = /* @__PURE__ */ new Map();
    for (const event of mentions) {
      const channelId = tagValue(event, "h");
      if (!channelId) continue;
      const root = rootOf(event);
      const bucket = byRoot.get(root);
      if (bucket) bucket.events.push(event);
      else byRoot.set(root, { channelId, events: [event] });
    }
    const answered = /* @__PURE__ */ new Map();
    for (const event of await relay.mineIn([...byRoot.keys()])) {
      const root = rootOf(event);
      answered.set(root, Math.max(answered.get(root) ?? 0, event.created_at));
    }
    const newest = (item) => item.events[item.events.length - 1].created_at;
    const unread = [...byRoot.entries()].filter(([root, item]) => newest(item) > (answered.get(root) ?? 0)).sort((a, b) => newest(a[1]) - newest(b[1])).slice(-8);
    if (unread.length === 0) {
      this.scope = setItems(this.scope.channel, [], null);
      this.paintScope();
      this.reply("Inbox is clear.");
      return;
    }
    const channels = this.channels();
    const names = await relay.profiles([...new Set(unread.flatMap(([, item]) => item.events.map((e) => e.pubkey)))]);
    const channelName = (id) => channels.find((c) => c.id === id)?.name ?? "a channel";
    const blocks = unread.map(([, item], index2) => {
      const lines = item.events.slice(-4).map((event) => {
        const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
        const when = new Date(event.created_at * 1e3).toLocaleString();
        return `  ${who} (${when}): ${event.content.replace(/\s+/g, " ").slice(0, 600)}`;
      });
      return [`Unread ${index2 + 1}, in ${channelName(item.channelId)}:`, ...lines].join("\n");
    });
    const described = unread.map(([root, item]) => {
      const last = item.events[item.events.length - 1];
      return {
        rootId: root,
        channelId: item.channelId,
        channelName: channelName(item.channelId),
        label: plain(last.content).slice(0, 70) || root.slice(0, 8),
        who: [...new Set(item.events.map((e) => names.get(e.pubkey) ?? e.pubkey.slice(0, 8)))],
        lastAt: last.created_at
      };
    });
    const answer = await summarizeInbox(this.requireLlm(), question, blocks);
    const picked = (answer.thread ? described[answer.thread - 1] ?? null : null) ?? (described.length === 1 ? described[0] : null);
    const home = picked ? channels.find((c) => c.id === picked.channelId) ?? null : null;
    this.scope = setItems(home ?? this.scope.channel, described, picked);
    this.paintScope();
    this.reply(answer.answer);
  }
  editPending(body) {
    if (this.state.pending) this.set({ pending: { ...this.state.pending, body } });
  }
  cancel() {
    this.awaitingYesNo = false;
    if (this.state.pending) this.say("app", "Cancelled.");
    this.set({ pending: null, status: "" });
  }
  async publish() {
    const relay = this.deps.relay();
    const pending = this.state.pending;
    if (!relay || !pending) return;
    if (pending.todo) {
      this.awaitingYesNo = false;
      this.set({ pending: null });
      try {
        await this.publishTodo(relay, pending);
      } catch (error) {
        this.reply(`That did not save: ${message(error)}`, { bad: true });
      }
      return;
    }
    const body = pending.body.trim();
    if (!body) return;
    this.awaitingYesNo = false;
    this.set({ pending: null });
    const { channel, replyTo } = pending;
    const mentioned = mentionsIn(body, pending.members);
    try {
      this.setStatus(`Posting to ${channel.name}...`);
      const event = relay.postMessage({
        channelId: channel.id,
        content: body,
        mentions: mentioned.map((m) => m.pubkey),
        replyTo: replyTo ?? void 0
      });
      const rootId = replyTo ?? event.id;
      this.track({
        rootId,
        channelId: channel.id,
        channelName: channel.name,
        instruction: body.slice(0, 160),
        createdAt: event.created_at,
        state: "unknown"
      });
      const existing = replyTo ? this.scope.threads.find((t) => t.rootId === replyTo) : void 0;
      this.scope = rememberPost(
        this.scope,
        channel,
        existing ?? {
          rootId,
          channelId: channel.id,
          channelName: channel.name,
          label: plain(body).slice(0, 70),
          who: mentioned.length ? [mentioned[0].name] : [],
          lastAt: event.created_at
        }
      );
      this.paintScope();
      this.watch({ rootId, channelId: channel.id, channelName: channel.name, label: body, since: event.created_at });
      this.say("app", body, {
        meta: `Posted to ${channel.name}${replyTo ? ", in thread" : ""}`,
        link: { channelId: channel.id, messageId: event.id, rootId }
      });
      this.setStatus(`Posted to ${channel.name}. Watching for a reply.`);
      this.speaker.speak("Posted.");
    } catch (error) {
      this.reply(`That did not send: ${message(error)}`, { bad: true });
    }
  }
  watch(input) {
    const watch = { ...input, label: input.label.replace(/\s+/g, " ").slice(0, 90), until: now() + WATCH_HOURS * 3600 };
    const rest = this.state.watches.filter((w) => w.rootId !== watch.rootId);
    const watches = [watch, ...rest].slice(0, MAX_WATCHES);
    saveJson(WATCH_KEY, watches);
    this.set({ watches });
  }
  unwatch(rootId) {
    const watches = this.state.watches.filter((w) => w.rootId !== rootId);
    saveJson(WATCH_KEY, watches);
    this.set({ watches });
  }
  isWatching(rootId) {
    return this.state.watches.some((w) => w.rootId === rootId);
  }
  async tick() {
    const relay = this.deps.relay();
    if (!relay || this.polling) return;
    const live = this.state.watches.filter((w) => w.until > now());
    if (live.length !== this.state.watches.length) {
      saveJson(WATCH_KEY, live);
      this.set({ watches: live });
    }
    if (live.length === 0) return;
    this.polling = true;
    try {
      const since = Math.min(...live.map((w) => w.since)) + 1;
      const events = await relay.repliesIn(live.map((w) => w.rootId), since);
      const byRoot = new Map(live.map((w) => [w.rootId, w]));
      const fresh = [];
      for (const event of events) {
        if (event.pubkey === relay.pubkey) continue;
        const watch = byRoot.get(rootOf(event)) ?? byRoot.get(event.id);
        if (!watch || event.created_at <= watch.since) continue;
        fresh.push({ watch, event });
      }
      if (fresh.length === 0) return;
      const names = await relay.profiles([...new Set(fresh.map((f) => f.event.pubkey))]);
      const seen = /* @__PURE__ */ new Map();
      for (const { watch, event } of fresh) {
        seen.set(watch.rootId, Math.max(seen.get(watch.rootId) ?? 0, event.created_at));
      }
      const watches = this.state.watches.map((w) => seen.has(w.rootId) ? { ...w, since: seen.get(w.rootId) } : w);
      saveJson(WATCH_KEY, watches);
      this.set({ watches });
      for (const { watch, event } of fresh.sort((a, b) => a.event.created_at - b.event.created_at)) {
        const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
        this.say("app", event.content, {
          meta: `${who} in ${watch.channelName}`,
          link: { channelId: watch.channelId, messageId: event.id, rootId: watch.rootId }
        });
        this.tracked = this.tracked.map(
          (t) => t.rootId === watch.rootId ? { ...t, lastReply: event.content.replace(/\s+/g, " ").slice(0, 240) } : t
        );
        if (!this.state.listening) this.speaker.speak(spoken(who, watch.channelName, event.content));
      }
      saveJson(TRACK_KEY, this.tracked.slice(0, 100));
    } catch {
      return;
    } finally {
      this.polling = false;
    }
  }
  track(thread) {
    this.tracked = [thread, ...this.tracked.filter((t) => t.rootId !== thread.rootId)].slice(0, 100);
    saveJson(TRACK_KEY, this.tracked);
  }
  async refreshTracked(relay) {
    if (this.tracked.length === 0) return;
    const roots = this.tracked.map((t) => t.rootId);
    const reactions = await relay.query([{ kinds: [7], "#e": roots, limit: 500 }]).catch(() => []);
    const latest = /* @__PURE__ */ new Map();
    for (const reaction of reactions) {
      const root = reaction.tags.filter((t) => t[0] === "e").at(-1)?.[1];
      if (!root) continue;
      const key = `${root}:${reaction.pubkey}`;
      const seen = latest.get(key);
      if (!seen || seen.created_at < reaction.created_at) latest.set(key, reaction);
    }
    const byRoot = /* @__PURE__ */ new Map();
    for (const reaction of latest.values()) {
      const root = reaction.tags.filter((t) => t[0] === "e").at(-1)?.[1];
      if (!root || !EMOJI_STATE.has(reaction.content.trim())) continue;
      const seen = byRoot.get(root);
      if (!seen || seen.created_at < reaction.created_at) byRoot.set(root, reaction);
    }
    this.tracked = this.tracked.map((thread) => {
      const reaction = byRoot.get(thread.rootId);
      return reaction ? { ...thread, state: EMOJI_STATE.get(reaction.content.trim()) ?? thread.state } : thread;
    });
    saveJson(TRACK_KEY, this.tracked);
  }
  summarizeTracked(filter) {
    const matching = filter === "all" ? this.tracked : this.tracked.filter((t) => t.state === filter);
    if (matching.length === 0) {
      return filter === "all" ? "Nothing is tracked yet." : `Nothing is ${filter.replace("-", " ")}.`;
    }
    const lines = matching.slice(0, 6).map((t) => `${t.channelName}: ${t.instruction}${t.lastReply ? `. Last update: ${t.lastReply}` : ""}`);
    const heading = filter === "all" ? `${matching.length} tracked ${matching.length === 1 ? "thread" : "threads"}.` : `${matching.length} ${filter.replace("-", " ")}.`;
    return [heading, ...lines].join(" ");
  }
};
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/relay.ts
var KIND_MESSAGE = 9;
var KIND_REACTION = 7;
var KIND_DELETE = 5;
var CHUNK = 50;
var READ_LIMIT = 500;
function chunk(list2, size) {
  const out = [];
  for (let i = 0; i < list2.length; i += size) out.push(list2.slice(i, i + size));
  return out;
}
function byTime(a, b) {
  return a.created_at - b.created_at;
}
var Relay = class {
  constructor(session, pubkey) {
    this.session = session;
    this.pubkey = pubkey;
  }
  channels() {
    return this.session.channels.list().channels.filter(
      (c) => !c.huddle && !c.archived && c.channelType !== "system" && c.channelType !== "dm" && c.channelType !== "solo"
    ).map((c) => ({ id: c.id, name: c.name, description: c.description, members: c.members, readOnly: c.readOnly }));
  }
  async query(filters) {
    const bounded = filters.map((filter) => ({ ...filter, limit: Math.max(1, Math.min(READ_LIMIT, filter.limit ?? READ_LIMIT)) }));
    return [...await this.session.read(bounded)];
  }
  async byIds(ids) {
    const unique = [...new Set(ids)];
    const found = [];
    for (const batch of chunk(unique, CHUNK)) {
      found.push(...await this.query([{ ids: batch, limit: batch.length }]));
    }
    return found;
  }
  async messagesInThread(channelId, rootId) {
    const events = await this.query([{ kinds: [KIND_MESSAGE], "#h": [channelId], "#e": [rootId], limit: 200 }]);
    return events.sort(byTime);
  }
  async threads(channelId, limit = 80) {
    const events = (await this.query([{ kinds: [KIND_MESSAGE], "#h": [channelId], limit }])).sort(byTime);
    const byRoot = /* @__PURE__ */ new Map();
    for (const event of events) {
      const root = rootOf(event);
      const bucket = byRoot.get(root);
      if (bucket) bucket.push(event);
      else byRoot.set(root, [event]);
    }
    const missing = [...byRoot.keys()].filter((id) => !events.some((e) => e.id === id));
    if (missing.length) {
      for (const root of await this.byIds(missing).catch(() => [])) {
        byRoot.get(root.id)?.unshift(root);
      }
    }
    return [...byRoot.entries()].map(([rootId, messages]) => ({ rootId, messages, lastAt: messages[messages.length - 1].created_at })).sort((a, b) => a.lastAt - b.lastAt);
  }
  async repliesIn(rootIds, since) {
    if (rootIds.length === 0) return [];
    const events = await this.query([{ kinds: [KIND_MESSAGE], "#e": rootIds, since, limit: 200 }]);
    return events.filter((e) => e.created_at >= since).sort(byTime);
  }
  async mentions(since) {
    const events = await this.query([{ kinds: [KIND_MESSAGE], "#p": [this.pubkey], since, limit: 200 }]);
    return events.filter((e) => e.pubkey !== this.pubkey).sort(byTime);
  }
  async mineIn(rootIds) {
    if (rootIds.length === 0) return [];
    return this.query([{ kinds: [KIND_MESSAGE], authors: [this.pubkey], "#e": rootIds, limit: 200 }]);
  }
  async allReactions(channelIds, total = 1e3) {
    const pages = await Promise.all(
      chunk(channelIds, CHUNK).map(async (ids) => {
        const found = /* @__PURE__ */ new Map();
        let until;
        while (found.size < total) {
          const page = await this.query([{ kinds: [KIND_REACTION], "#h": ids, limit: READ_LIMIT, ...until ? { until } : {} }]);
          const before = found.size;
          for (const event of page) found.set(event.id, event);
          if (page.length < READ_LIMIT || found.size === before) break;
          until = Math.min(...page.map((e) => e.created_at));
        }
        return [...found.values()];
      })
    );
    return pages.flat();
  }
  async deleted(ids) {
    const gone = /* @__PURE__ */ new Set();
    for (const batch of chunk(ids, CHUNK)) {
      const events = await this.query([{ kinds: [KIND_DELETE], "#e": batch, limit: batch.length * 2 }]);
      for (const event of events) {
        for (const tag of event.tags) if (tag[0] === "e" && tag[1]) gone.add(tag[1]);
      }
    }
    return gone;
  }
  async profiles(pubkeys) {
    const unique = [...new Set(pubkeys)];
    if (unique.length) await this.session.profiles.ensure(unique).catch(() => void 0);
    const snapshot = this.session.profiles.snapshot();
    const names = /* @__PURE__ */ new Map();
    for (const pubkey of unique) {
      const name = snapshot.get(pubkey)?.name;
      if (name) names.set(pubkey, name);
    }
    return names;
  }
  async members(channel) {
    let roster = [...channel.members ?? []];
    if (roster.length === 0) {
      const lists = await this.query([{ kinds: [39002], "#d": [channel.id], limit: 5 }]).catch(() => []);
      const newest = lists.sort(byTime).at(-1);
      roster = newest ? newest.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]) : [];
    }
    const ids = [...new Set(roster)].filter((id) => id !== this.pubkey);
    const names = await this.profiles(ids);
    return ids.map((pubkey) => ({ pubkey, name: names.get(pubkey) ?? "" })).filter((m) => m.name);
  }
  async readCanvas(channelId) {
    const canvas = this.session.canvas;
    if (!canvas) throw new Error("This Buzz build has no Canvas.");
    return await canvas.read(channelId) ?? null;
  }
  /** Applies `edit` to the latest Canvas, retrying once if someone saved in between. */
  async editCanvas(channelId, edit) {
    const canvas = this.session.canvas;
    if (!canvas?.available) throw new Error("Canvas writing is unavailable here.");
    for (let attempt = 0; ; attempt += 1) {
      const head = await canvas.read(channelId) ?? null;
      const next = edit(head?.content ?? "");
      const wait = ((head?.created_at ?? 0) + 1) * 1e3 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1e3)));
      try {
        return await canvas.save(channelId, next, head?.id, { preserveApproval: true });
      } catch (error) {
        if (attempt > 0 || !/Canvas changed/.test(String(error?.message))) throw error;
      }
    }
  }
  canReact() {
    const outbox = this.session.outbox;
    return !!outbox?.supports(KIND_REACTION) && outbox.supports(KIND_DELETE);
  }
  react(target, emoji) {
    const outbox = this.session.outbox;
    const channelId = target.tags.find((t) => t[0] === "h")?.[1];
    if (!outbox?.supports(KIND_REACTION) || !channelId) throw new Error("This Buzz connection cannot add reactions.");
    const tags = [
      ["h", channelId],
      ["e", target.id],
      ["p", target.pubkey]
    ];
    const id = outbox.send({ kind: KIND_REACTION, content: emoji, tags });
    return { id, pubkey: this.pubkey, created_at: Math.floor(Date.now() / 1e3), kind: KIND_REACTION, content: emoji, tags };
  }
  unreact(reactions, channelId) {
    const outbox = this.session.outbox;
    if (!outbox?.supports(KIND_DELETE)) throw new Error("This Buzz connection cannot remove reactions.");
    for (const reaction of reactions) {
      if (reaction.pubkey !== this.pubkey) continue;
      outbox.send({ kind: KIND_DELETE, content: "", tags: [["h", channelId], ["e", reaction.id], ["k", String(KIND_REACTION)]] });
    }
  }
  postMessage(options) {
    const created_at = Math.floor(Date.now() / 1e3);
    const outbox = this.session.outbox;
    if (options.mentions?.length && outbox?.supports(KIND_MESSAGE)) {
      const tags = [["h", options.channelId]];
      if (options.replyTo) tags.push(["e", options.replyTo, "", "reply"]);
      for (const p of options.mentions) tags.push(["p", p]);
      return { id: outbox.send({ kind: KIND_MESSAGE, content: options.content, tags }), created_at };
    }
    const id = options.replyTo ? this.session.messages.reply(options.channelId, options.replyTo, options.content) : this.session.messages.send(options.channelId, options.content);
    return { id, created_at };
  }
};

// src/flags.ts
var REACTION_LIMIT = 1e3;
function targetOf(reaction) {
  return reaction.tags.filter((t) => t[0] === "e" && t[1]).at(-1)?.[1];
}
function emojiOf(reaction) {
  return reaction.content.replace(/️/g, "").trim();
}
function line(text3) {
  return text3.replace(/```[\s\S]*?```/g, " ").replace(/[*_~`]+/g, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
}
function emptyFlagSource() {
  return { reactions: [], messages: /* @__PURE__ */ new Map(), names: /* @__PURE__ */ new Map(), mine: "" };
}
async function loadFlags(relay) {
  const channelIds = relay.channels().map((c) => c.id);
  const all2 = await relay.allReactions(channelIds, REACTION_LIMIT);
  const usable = all2.filter((event) => emojiOf(event) && emojiOf(event) !== "-" && targetOf(event));
  const gone = await relay.deleted(usable.map((event) => event.id));
  const live = usable.filter((event) => !gone.has(event.id));
  const messages = /* @__PURE__ */ new Map();
  for (const event of await relay.byIds(live.map((r) => targetOf(r)))) messages.set(event.id, event);
  const roots = [...messages.values()].map(rootOf).filter((id) => !messages.has(id));
  for (const event of await relay.byIds(roots)) messages.set(event.id, event);
  const reactions = live.filter((event) => messages.has(targetOf(event)));
  const names = await relay.profiles([...new Set(reactions.map((event) => event.pubkey))]);
  return { reactions, messages, names, mine: relay.pubkey };
}
function selected(source, filter) {
  return source.reactions.filter(
    (event) => (!filter.mineOnly || event.pubkey === source.mine) && (!filter.emoji || emojiOf(event) === filter.emoji)
  );
}
function emojiCounts(source, mineOnly) {
  const threads = /* @__PURE__ */ new Map();
  for (const event of selected(source, { mineOnly, emoji: null })) {
    const target = source.messages.get(targetOf(event));
    if (!target) continue;
    const emoji = emojiOf(event);
    const seen = threads.get(emoji) ?? /* @__PURE__ */ new Set();
    seen.add(rootOf(target));
    threads.set(emoji, seen);
  }
  return [...threads.entries()].map(([emoji, seen]) => [emoji, seen.size]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
function groupFlags(source, channelNames, filter) {
  const byRoot = /* @__PURE__ */ new Map();
  for (const event of selected(source, filter)) {
    const target = source.messages.get(targetOf(event));
    if (!target) continue;
    const channelId = tagValue(target, "h");
    if (!channelId) continue;
    const rootId = rootOf(target);
    const root = source.messages.get(rootId) ?? target;
    let flag = byRoot.get(rootId);
    if (!flag) {
      flag = {
        rootId,
        messageId: target.id,
        channelId,
        channelName: channelNames.get(channelId) ?? "a channel",
        title: line(root.content).slice(0, 90) || rootId.slice(0, 8),
        excerpt: "",
        emoji: [],
        who: [],
        at: 0
      };
      byRoot.set(rootId, flag);
    }
    const emoji = emojiOf(event);
    if (!flag.emoji.includes(emoji)) flag.emoji.push(emoji);
    const who = source.names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
    if (!flag.who.includes(who)) flag.who.push(who);
    if (event.created_at > flag.at) {
      flag.at = event.created_at;
      flag.messageId = target.id;
      flag.excerpt = target.id === rootId ? "" : line(target.content).slice(0, 110);
    }
  }
  return [...byRoot.values()].sort((a, b) => b.at - a.at);
}
var DEFAULT_FLAGS = ["\u{1F6A9}", "\u{1F440}", "\u2705", "\u2757"];
function myFlags(source, rootId) {
  return source.reactions.filter((event) => {
    if (event.pubkey !== source.mine) return false;
    const target = source.messages.get(targetOf(event));
    return !!target && rootOf(target) === rootId;
  });
}
function emojiOfFlag(event) {
  return emojiOf(event);
}
function withReaction(source, reaction) {
  return { ...source, reactions: [reaction, ...source.reactions] };
}
function withoutReactions(source, ids) {
  return { ...source, reactions: source.reactions.filter((event) => !ids.has(event.id)) };
}

// src/ui.ts
var TAP_MS = 400;
var FLAG_REFRESH_MS = 6e4;
var PENDING_MS = 5 * 6e4;
var VIEW_KEY = "buzz-voice-plugin.view";
var DEFAULT_VIEW = { tab: "talk", mineOnly: false, emoji: null, open: null, scroll: 0 };
var SETTINGS_SECTION = "blueoi.buzz-voice/settings";
function scopeOf(connection) {
  const scope = connection.scope ?? "";
  const at = scope.lastIndexOf(":");
  if (at < 0 || scope.slice(at + 1) !== connection.viewer) return void 0;
  return { communityOrigin: scope.slice(0, at), viewer: connection.viewer };
}
function ago(seconds) {
  const delta = Math.max(0, Math.floor(Date.now() / 1e3) - seconds);
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}
var CSS = `
.bv-root{display:flex;flex-direction:column;height:100%;min-height:0}
.bv-body{display:flex;flex-direction:column;flex:1;min-height:0}
.bv-bar{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;padding:var(--space-2) var(--space-panel-inset)}
.bv-segmented{width:100%;max-width:18rem}
.bv-segmented[data-compact]{max-width:12rem}
.bv-segmented .buzz-tabs-tab[data-selected]{background:var(--surface-control-selected);box-shadow:var(--shadow-xs)}
.bv-dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--text-disabled);flex:none}
.bv-dot[data-state=online]{background:var(--text-success)}
.bv-dot[data-state=error]{background:var(--text-danger)}
.bv-scope{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;padding:0 var(--space-panel-inset) var(--space-2);min-width:0}
.bv-truncate{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bv-log{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-2) var(--space-panel-inset) var(--space-4)}
.bv-log>.buzz-empty-state{margin:auto 0}
.bv-turn{display:flex;flex-direction:column;gap:var(--space-1);max-width:min(85%,42rem)}
.bv-turn[data-role=you]{align-self:flex-end;align-items:flex-end}
.bv-turn[data-role=app]{align-self:flex-start}
.bv-bubble{padding:var(--space-2) var(--space-3);border-radius:var(--radius-card);white-space:pre-wrap;overflow-wrap:anywhere}
.bv-turn[data-role=you] .bv-bubble{background:var(--surface-message-own);color:var(--text-message-own)}
.bv-turn[data-role=app] .bv-bubble{background:var(--surface-inset);color:var(--text-standard)}
.bv-turn[data-bad] .bv-bubble{color:var(--text-danger)}
.bv-meta{display:flex;align-items:center;gap:var(--space-2);padding:0 var(--space-1)}
.bv-card{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-4);border:1px solid var(--border-standard);border-radius:var(--radius-container);background:var(--surface-panel);box-shadow:var(--shadow-card)}
.bv-row{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap}
.bv-row-end{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end}
.bv-footer{flex:none;display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3) var(--space-panel-inset) var(--space-4);border-top:1px solid var(--border-standard)}
.bv-talk{display:flex;align-items:center;justify-content:center;gap:var(--space-2);width:100%;min-height:3.5rem;border:1px solid var(--border-standard);border-radius:var(--radius-container);background:var(--surface-inset);color:var(--text-standard);font:inherit;cursor:pointer;touch-action:none;user-select:none;transition:background var(--duration-fast),color var(--duration-fast)}
.bv-talk:hover:not(:disabled){background:var(--affordance-subtle-hover)}
.bv-talk[data-listening]{background:var(--affordance-accent-prominent);border-color:transparent;color:var(--text-on-accent)}
.bv-talk:disabled{opacity:.55;cursor:default}
.bv-talk svg{flex:none}
.bv-meter{height:.1875rem;border-radius:var(--radius-pill);background:var(--surface-inset);overflow:hidden}
.bv-meter>span{display:block;height:100%;background:var(--affordance-accent-prominent);transition:width 60ms linear}
.bv-status{min-height:1.25rem;margin:0;text-align:center}
.bv-type{display:flex;gap:var(--space-2);align-items:center}
.bv-type>.buzz-input{flex:1;min-width:0}
.bv-scroll{flex:1;min-height:0;overflow-y:auto;padding:0 var(--space-panel-inset) var(--space-6)}
.bv-flags{list-style:none;margin:0;padding:0}
.bv-flag{display:flex;flex-direction:column;gap:var(--space-1);border-bottom:1px solid var(--border-standard);padding:var(--space-1) 0}
.bv-flag-main{display:flex;align-items:flex-start;gap:var(--space-2)}
.bv-flag-picker{display:flex;align-items:center;gap:var(--space-1);flex-wrap:wrap;padding:0 var(--space-2) var(--space-2) calc(2.75rem + var(--space-3) + var(--space-2))}
.bv-flag-side [data-mine]{color:var(--text-accent, var(--affordance-accent-prominent))}
.bv-flag:last-child{border-bottom:0}
.bv-flag-open{display:flex;gap:var(--space-3);flex:1;min-width:0;padding:var(--space-2);border:0;border-radius:var(--radius-row);background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bv-flag-open:hover{background:var(--affordance-row-hover)}
.bv-flag-emoji{flex:none;min-width:2.75rem;white-space:nowrap;font-size:1.125rem;line-height:1.5rem}
.bv-flag-text{display:flex;flex-direction:column;gap:var(--space-half);min-width:0}
.bv-flag-side{flex:none;display:flex;align-items:center;gap:var(--space-1);padding-top:var(--space-1)}
.bv-settings{display:flex;flex-direction:column}
.bv-settings>.buzz-content-header[data-inline]{margin-top:var(--space-section-gap);margin-bottom:var(--space-2)}
.bv-form{display:flex;flex-direction:column;gap:var(--space-4)}
.bv-settings>.buzz-settings-group+.buzz-settings-group{margin-top:var(--space-3)}
.bv-kbd{font-family:var(--font-mono, ui-monospace, monospace);padding:0 var(--space-1);border:1px solid var(--border-standard);border-radius:var(--radius-chip);background:var(--surface-inset)}
`;
var ICON = {
  mic: "M128 176a48.05 48.05 0 0 0 48-48V64a48 48 0 0 0-96 0v64a48.05 48.05 0 0 0 48 48ZM96 64a32 32 0 0 1 64 0v64a32 32 0 0 1-64 0Zm40 143.6V232a8 8 0 0 1-16 0v-24.4A80.11 80.11 0 0 1 48 128a8 8 0 0 1 16 0 64 64 0 0 0 128 0 8 8 0 0 1 16 0 80.11 80.11 0 0 1-72 79.6Z",
  stop: "M200 40H56a16 16 0 0 0-16 16v144a16 16 0 0 0 16 16h144a16 16 0 0 0 16-16V56a16 16 0 0 0-16-16Zm0 160H56V56h144Z",
  speakerOff: "M53.92 34.62a8 8 0 1 0-11.84 10.76L73.55 80H32a16 16 0 0 0-16 16v64a16 16 0 0 0 16 16h43.25l69.84 54.31A8 8 0 0 0 160 224v-46.24l42.08 46.29a8 8 0 1 0 11.84-10.76ZM32 96h40v64H32Zm112 111.64-56-43.55V95.06l56 61.6Zm-42.32-148.8a8 8 0 0 1 1.4-11.23l41.83-32.53A8 8 0 0 1 160 32v76.92a8 8 0 0 1-16 0V48.36l-31.08 24.17a8 8 0 0 1-11.24-1.4Zm110.4 105.39a8 8 0 0 1-11-2.7 47.85 47.85 0 0 0 0-49.06 8 8 0 1 1 13.7-8.28 63.81 63.81 0 0 1 0 65.62 8 8 0 0 1-2.7 2.7Zm32.25-.92A95.43 95.43 0 0 0 248 128a95.35 95.35 0 0 0-14.72-51 8 8 0 1 1 13.56-8.5 111.45 111.45 0 0 1 0 119 8 8 0 1 1-13.56-8.5Z",
  plus: "M224 128a8 8 0 0 1-8 8h-80v80a8 8 0 0 1-16 0v-80H40a8 8 0 0 1 0-16h80V40a8 8 0 0 1 16 0v80h80a8 8 0 0 1 8 8Z",
  gear: "M128 80a48 48 0 1 0 48 48 48.05 48.05 0 0 0-48-48Zm0 80a32 32 0 1 1 32-32 32 32 0 0 1-32 32Zm88-29.84q.06-2.16 0-4.32l14.92-18.64a8 8 0 0 0 1.48-7.06 107.6 107.6 0 0 0-10.88-26.25 8 8 0 0 0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186 40.54a8 8 0 0 0-3.94-6 107.29 107.29 0 0 0-26.25-10.86 8 8 0 0 0-7.06 1.48L130.16 40q-2.16-.06-4.32 0L107.2 25.11a8 8 0 0 0-7.06-1.48 107.6 107.6 0 0 0-26.25 10.88 8 8 0 0 0-3.93 6l-2.64 23.76q-1.56 1.49-3 3L40.54 70a8 8 0 0 0-6 3.94 107.71 107.71 0 0 0-10.87 26.25 8 8 0 0 0 1.49 7.06L40 125.84q-.06 2.16 0 4.32L25.11 148.8a8 8 0 0 0-1.48 7.06 107.6 107.6 0 0 0 10.88 26.25 8 8 0 0 0 6 3.93l23.72 2.64q1.49 1.56 3 3L70 215.46a8 8 0 0 0 3.94 6 107.71 107.71 0 0 0 26.25 10.87 8 8 0 0 0 7.06-1.49L125.84 216q2.16.06 4.32 0l18.64 14.92a8 8 0 0 0 7.06 1.48 107.21 107.21 0 0 0 26.25-10.88 8 8 0 0 0 3.93-6l2.64-23.72q1.56-1.48 3-3l23.78-2.8a8 8 0 0 0 6-3.94 107.71 107.71 0 0 0 10.87-26.25 8 8 0 0 0-1.49-7.06Zm-16.1-6.5a73.93 73.93 0 0 1 0 8.68 8 8 0 0 0 1.74 5.48l14.19 17.73a91.57 91.57 0 0 1-6.23 15l-22.6 2.56a8 8 0 0 0-5.1 2.64 74.11 74.11 0 0 1-6.14 6.14 8 8 0 0 0-2.64 5.1l-2.51 22.58a91.32 91.32 0 0 1-15 6.23l-17.74-14.19a8 8 0 0 0-5-1.75h-.48a73.93 73.93 0 0 1-8.68 0 8 8 0 0 0-5.48 1.74l-17.78 14.2a91.57 91.57 0 0 1-15-6.23L82.89 187a8 8 0 0 0-2.64-5.1 74.11 74.11 0 0 1-6.14-6.14 8 8 0 0 0-5.1-2.64l-22.58-2.52a91.32 91.32 0 0 1-6.23-15l14.19-17.74a8 8 0 0 0 1.74-5.48 73.93 73.93 0 0 1 0-8.68 8 8 0 0 0-1.74-5.48L40.2 100.45a91.57 91.57 0 0 1 6.23-15L69 82.89a8 8 0 0 0 5.1-2.64 74.11 74.11 0 0 1 6.14-6.14A8 8 0 0 0 82.89 69l2.51-22.57a91.32 91.32 0 0 1 15-6.23l17.74 14.19a8 8 0 0 0 5.48 1.74 73.93 73.93 0 0 1 8.68 0 8 8 0 0 0 5.48-1.74l17.77-14.19a91.57 91.57 0 0 1 15 6.23L173.11 69a8 8 0 0 0 2.64 5.1 74.11 74.11 0 0 1 6.14 6.14 8 8 0 0 0 5.1 2.64l22.58 2.51a91.32 91.32 0 0 1 6.23 15l-14.19 17.74a8 8 0 0 0-1.74 5.53Z",
  refresh: "M240 56v48a8 8 0 0 1-8 8h-48a8 8 0 0 1 0-16h27.4l-26.59-24.36-.25-.24a80 80 0 1 0-1.67 114.78 8 8 0 0 1 11 11.63A95.44 95.44 0 0 1 128 224h-1.32a96 96 0 1 1 69.07-164L224 85.8V56a8 8 0 0 1 16 0Z",
  flag: "M42.76 50A8 8 0 0 0 40 56v168a8 8 0 0 0 16 0v-44.23c26.79-21.16 49.87-9.75 76.45 3.41 16.4 8.11 34.06 16.85 53 16.85 13.93 0 28.54-4.75 43.82-18a8 8 0 0 0 2.76-6V56a8 8 0 0 0-13.27-6c-28 24.23-51.72 12.49-79.21-1.12C111.07 34.76 78.78 18.79 42.76 50ZM216 172.25c-26.79 21.16-49.87 9.74-76.45-3.41-25-12.35-52.81-26.13-83.55-8.4V59.79c26.79-21.16 49.87-9.75 76.45 3.4 25 12.35 52.82 26.13 83.55 8.4Z"
};
function createUi(deps) {
  const { React, controller, relayService, navigation } = deps;
  const h = React.createElement;
  const { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } = React;
  const view = { ...DEFAULT_VIEW, ...loadJson(VIEW_KEY, {}), open: null, scroll: 0 };
  const saveView = (patch) => {
    Object.assign(view, patch);
    saveJson(VIEW_KEY, { tab: view.tab, mineOnly: view.mineOnly, emoji: view.emoji });
  };
  let flagCache = null;
  const pending = { added: /* @__PURE__ */ new Map(), removed: /* @__PURE__ */ new Map() };
  const overlay = (loaded) => {
    const now2 = Date.now();
    for (const [id, at] of pending.removed) if (now2 - at > PENDING_MS) pending.removed.delete(id);
    for (const [id, item] of pending.added) if (now2 - item.at > PENDING_MS) pending.added.delete(id);
    const have = new Set(loaded.reactions.map((event) => event.id));
    const extra = [...pending.added.values()].map((item) => item.event).filter((event) => !have.has(event.id));
    return { ...loaded, reactions: [...extra, ...loaded.reactions].filter((event) => !pending.removed.has(event.id)) };
  };
  const useVoice = () => useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const useConnection = () => useSyncExternalStore(relayService.subscribe, relayService.snapshot, relayService.snapshot);
  const Icon = ({ name, size = 16 }) => h(
    "svg",
    { width: size, height: size, viewBox: "0 0 256 256", fill: "currentColor", "aria-hidden": true, focusable: "false" },
    h("path", { d: ICON[name] })
  );
  function Button({
    variant = "subtle",
    size = "md",
    loading = false,
    disabled,
    children,
    ...props
  }) {
    return h(
      "button",
      {
        type: "button",
        ...props,
        disabled: disabled || loading,
        "aria-busy": loading || void 0,
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": variant,
        "data-size": size,
        "data-button-shape": "capsule",
        "data-loading": loading || void 0
      },
      h("span", { className: "buzz-button-label" }, children)
    );
  }
  function IconButton({ label, icon, ...props }) {
    return h(
      "button",
      {
        type: "button",
        ...props,
        "aria-label": label,
        title: label,
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": "ghost",
        "data-size": "sm",
        "data-button-shape": "capsule",
        "data-icon-variant": "ghost",
        "data-icon-size": "sm",
        "data-icon-shape": "control"
      },
      h("span", { className: "buzz-button-label" }, h(Icon, { name: icon }))
    );
  }
  const Input = (props) => h("input", { type: "text", ...props, "data-buzz-ui": "", "data-size": "md", className: "buzz-input" });
  function Field({ label, description, children }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-field" },
      h("label", { className: "buzz-field-label" }, label, children),
      description && h("p", { className: "buzz-field-description" }, description)
    );
  }
  function Header({ title, subtitle, inline = false, actions }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-content-header", "data-inline": inline || void 0 },
      h(
        "div",
        { className: "buzz-content-header-copy" },
        h(inline ? "h3" : "h2", { className: "buzz-content-header-title" }, title),
        subtitle && h("p", { className: "buzz-content-header-subtitle" }, subtitle)
      ),
      actions && h("div", { className: "buzz-content-header-actions" }, actions)
    );
  }
  const Group = ({ layout = "rows", children }) => h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": layout }, children);
  function Row({ title, subtitle, trailing }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-preference-row", "data-variant": "default" },
      h(
        "div",
        { className: "buzz-preference-row-content" },
        h("div", { className: "buzz-preference-row-label" }, title),
        subtitle && h("span", { className: "buzz-preference-row-description" }, subtitle)
      ),
      trailing != null && h("div", { className: "buzz-preference-row-trailing" }, trailing)
    );
  }
  function Switch({ checked, onChange, label }) {
    const state = checked ? { "data-checked": "" } : { "data-unchecked": "" };
    return h(
      "button",
      {
        type: "button",
        role: "switch",
        "aria-checked": checked,
        "aria-label": label,
        "data-buzz-ui": "",
        className: "buzz-switch-control",
        ...state,
        onClick: () => onChange(!checked)
      },
      h("span", { className: "buzz-switch-thumb", ...state })
    );
  }
  function EmptyState({ icon, title, description, action }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-empty-state" },
      h(
        "div",
        { className: "buzz-empty-state-content" },
        h("span", { className: "buzz-empty-state-icon", "aria-hidden": true }, h(Icon, { name: icon, size: 24 })),
        h(
          "div",
          { className: "buzz-empty-state-copy" },
          h("h3", { className: "buzz-empty-state-title" }, title),
          description != null && h("p", { className: "buzz-empty-state-description" }, description)
        ),
        action && h("div", { className: "buzz-empty-state-action" }, action)
      )
    );
  }
  function Segmented({ label, value, options, onChange, compact }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-tabs bv-segmented", "data-variant": "segmented", "data-size": "sm", "data-compact": compact || void 0 },
      h(
        "div",
        { className: "buzz-tabs-list", role: "tablist", "aria-label": label },
        options.map(
          ([id, text3]) => h(
            "button",
            {
              key: id,
              type: "button",
              role: "tab",
              className: "buzz-tabs-tab text-label-sm",
              "aria-selected": value === id,
              "data-selected": value === id ? "" : void 0,
              onClick: () => onChange(id)
            },
            text3
          )
        )
      )
    );
  }
  function openTarget(channelId, messageId, rootId) {
    const scope = scopeOf(relayService.snapshot());
    if (!scope) return;
    void navigation.open({ version: 1, kind: "conversation", scope, channelId, messageId, threadRootId: rootId });
  }
  const openSettings = () => void navigation.open({ version: 1, kind: "settings", section: SETTINGS_SECTION });
  function Setup({ voice }) {
    const engine = voice.engine;
    const missing = engine ? [!engine.engine && "the speech engine", !engine.model && `the whisper ${voice.settings.whisper} model`].filter(Boolean).join(" and ") : "";
    return h(EmptyState, {
      icon: "mic",
      title: "Set up speech",
      description: voice.engineError ? voice.engineError : `Speech is transcribed on this computer with sherpa-onnx, the same as the Buzz Voice app. ${missing ? `Install ${missing} to start.` : "Checking for the engine..."}`,
      action: h(
        "div",
        { className: "bv-row", style: { justifyContent: "center" } },
        h(
          Button,
          { variant: "prominent", loading: !!voice.installing, onClick: () => void controller.install() },
          voice.installing || "Install speech engine"
        ),
        h(Button, { variant: "subtle", onClick: () => void controller.refreshEngine() }, "Check again")
      )
    });
  }
  function Turn({ entry }) {
    return h(
      "div",
      { className: "bv-turn", "data-role": entry.role, "data-bad": entry.bad || void 0 },
      (entry.meta || entry.link) && h(
        "div",
        { className: "bv-meta text-caption text-subtle" },
        entry.meta && h("span", null, entry.meta),
        entry.link && h(
          Button,
          {
            variant: "link",
            size: "caption",
            onClick: () => openTarget(entry.link.channelId, entry.link.messageId, entry.link.rootId)
          },
          "Open in Buzz"
        )
      ),
      h("div", { className: "bv-bubble text-body-sm" }, entry.text)
    );
  }
  function Confirm({ voice }) {
    const pending2 = voice.pending;
    const ref = useRef(null);
    useEffect(() => {
      const field = ref.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange?.(field.value.length, field.value.length);
    }, [pending2.channel.id, pending2.replyTo]);
    useEffect(() => {
      const field = ref.current;
      if (!field) return;
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    }, [pending2.body]);
    const found = mentionsIn(pending2.body, pending2.members);
    const unmatched = found.length === 0 && pending2.body.includes("@");
    const escape = (text3) => text3.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (pending2.todo) return h(TodoConfirm, { voice, found });
    return h(
      "div",
      { className: "bv-card", role: "group", "aria-label": "Confirm message" },
      h(
        "div",
        { className: "bv-row" },
        h("span", { className: "text-label-sm text-standard" }, `#${pending2.channel.name}`),
        pending2.label && h("span", { className: "text-caption text-subtle bv-truncate" }, `in \u201C${pending2.label}\u201D`)
      ),
      h("textarea", {
        ref,
        "aria-label": "Message to send",
        value: pending2.body,
        rows: 2,
        spellCheck: false,
        "data-buzz-ui": "",
        className: "buzz-textarea",
        "data-variant": "text",
        "data-surface": "inset",
        "data-appearance": "field",
        style: { resize: "none", overflow: "hidden" },
        onChange: (event) => controller.editPending(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void controller.publish();
          }
          if (event.key === "Escape") controller.cancel();
        }
      }),
      h(
        "p",
        { className: `text-caption ${unmatched ? "text-danger" : "text-subtle"}`, style: { margin: 0 } },
        found.length ? `Notifies ${found.map((m) => m.name).join(", ")}` : unmatched ? "Nobody in this channel matches that name, so nobody will be notified." : "Nobody will be notified."
      ),
      found.length === 0 && pending2.members.length > 0 && h(
        "div",
        { className: "bv-row" },
        pending2.members.slice(0, 8).map(
          (member) => h(
            Button,
            {
              key: member.pubkey,
              variant: "subtle",
              size: "sm",
              onClick: () => {
                const stripped = pending2.addressed ? pending2.body.replace(new RegExp(`^\\s*@${escape(pending2.addressed)}\\s*`, "i"), "") : pending2.body;
                controller.editPending(`@${member.name} ${stripped.trim()}`);
              }
            },
            `@${member.name}`
          )
        )
      ),
      pending2.orphaned && h("p", { className: "text-caption text-warning", style: { margin: 0 } }, `No thread open in ${pending2.channel.name}, so this posts as a new message.`),
      h(
        "div",
        { className: "bv-row-end" },
        h("span", { className: "text-caption text-subtle", style: { marginRight: "auto" } }, "Enter or say \u201Cyes\u201D to send"),
        h(Button, { variant: "subtle", onClick: () => controller.cancel() }, "Cancel"),
        h(Button, { variant: "prominent", onClick: () => void controller.publish() }, "Send")
      )
    );
  }
  function TodoConfirm({ voice, found }) {
    const pending2 = voice.pending;
    const todo = pending2.todo;
    const verbs = { add: "Add todo", assign: "Assign todo", start: "Start todo", done: "Mark done", reopen: "Reopen todo" };
    const assigning = todo.op === "add" || todo.op === "assign";
    const keys = (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void controller.publish();
      }
      if (event.key === "Escape") controller.cancel();
    };
    return h(
      "div",
      { className: "bv-card", role: "group", "aria-label": "Confirm todo" },
      h(
        "div",
        { className: "bv-row" },
        h("span", { className: "text-label-sm text-standard" }, `${verbs[todo.op]} in #${pending2.channel.name}`),
        pending2.body && pending2.label && h("span", { className: "text-caption text-subtle bv-truncate" }, `tell in \u201C${pending2.label}\u201D`)
      ),
      todo.op === "add" ? h(Input, {
        "aria-label": "Todo",
        value: todo.label,
        autoFocus: true,
        onChange: (event) => controller.editTodoLabel(event.target.value),
        onKeyDown: keys
      }) : h("div", { className: "bv-bubble text-body-sm", style: { background: "var(--surface-inset)" } }, todo.label),
      assigning && h(
        "div",
        { className: "bv-row" },
        h("span", { className: "text-caption text-subtle" }, "Assignee"),
        [null, ...pending2.members.slice(0, 8)].map(
          (member) => h(
            Button,
            {
              key: member?.pubkey ?? "nobody",
              variant: (todo.assignee?.pubkey ?? null) === (member?.pubkey ?? null) ? "prominent" : "subtle",
              size: "sm",
              onClick: () => controller.assignPending(member)
            },
            member ? member.name : "Nobody"
          )
        )
      ),
      pending2.body && h("textarea", {
        "aria-label": "Message that notifies the assignee",
        value: pending2.body,
        rows: 2,
        spellCheck: false,
        "data-buzz-ui": "",
        className: "buzz-textarea",
        "data-variant": "text",
        "data-surface": "inset",
        "data-appearance": "field",
        style: { resize: "none" },
        onChange: (event) => controller.editPending(event.target.value),
        onKeyDown: keys
      }),
      h(
        "p",
        { className: "text-caption text-subtle", style: { margin: 0 } },
        found.length ? `Saves to Canvas, then mentions ${found.map((m) => m.name).join(", ")} ${pending2.replyTo ? "in the thread" : "in a new message"} so they pick it up.` : "Saves to the channel's Canvas todos. Nobody is notified."
      ),
      h(
        "div",
        { className: "bv-row-end" },
        h("span", { className: "text-caption text-subtle", style: { marginRight: "auto" } }, "Enter or say \u201Cyes\u201D to save"),
        h(Button, { variant: "subtle", onClick: () => controller.cancel() }, "Cancel"),
        h(Button, { variant: "prominent", onClick: () => void controller.publish() }, "Save")
      )
    );
  }
  function HandsFree({ voice }) {
    const word = voice.settings.wakeWord.trim() || "buzz";
    const label = !voice.handsFree ? "Hands-free off" : voice.hearing ? "Hearing you..." : voice.awake ? "Go ahead" : `Say \u201Chey ${word}\u201D`;
    return h(
      "div",
      { className: "bv-row", style: { justifyContent: "space-between" } },
      h(
        "span",
        { className: "bv-row text-caption text-subtle" },
        h("span", { className: "bv-dot", "data-state": voice.handsFree ? voice.hearing || voice.awake ? "online" : "idle" : void 0 }),
        label
      ),
      h(Switch, { label: "Hands-free", checked: voice.handsFree, onChange: () => controller.toggleHandsFree() })
    );
  }
  function TalkButton({ voice }) {
    const pressedAt = useRef(0);
    const label = voice.opening ? "Opening the microphone..." : voice.transcribing ? "Transcribing..." : voice.listening ? voice.latched ? "Recording. Tap to stop" : "Listening. Release to send" : "Tap or hold to talk";
    const down = (event) => {
      if (event.button !== void 0 && event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (voice.listening && voice.latched) {
        void controller.stopListening();
        return;
      }
      pressedAt.current = Date.now();
      void controller.startListening();
    };
    const up = () => {
      const now2 = controller.snapshot();
      if (!now2.listening || now2.latched) return;
      if (Date.now() - pressedAt.current < TAP_MS) controller.latch();
      else void controller.stopListening();
    };
    return h(
      "button",
      {
        type: "button",
        className: "bv-talk text-label",
        disabled: !voice.ready || voice.transcribing,
        "data-listening": voice.listening || void 0,
        "aria-pressed": voice.listening,
        onPointerDown: down,
        onPointerUp: up,
        onPointerCancel: up,
        onKeyDown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void controller.toggleListening();
          }
        }
      },
      h(Icon, { name: voice.listening ? "stop" : "mic", size: 20 }),
      label
    );
  }
  function Talk({ voice }) {
    const [typed, setTyped] = useState("");
    const log = useRef(null);
    useEffect(() => {
      if (voice.ready) controller.warmMicrophone();
    }, [voice.ready, voice.settings.microphone]);
    useEffect(() => {
      const node2 = log.current;
      if (node2) node2.scrollTop = node2.scrollHeight;
    }, [voice.log.length, !!voice.pending]);
    const level = Math.min(1, voice.level * 3);
    const watching = voice.watches.length;
    return h(
      Fragment,
      null,
      (voice.scope || watching > 0) && h(
        "div",
        { className: "bv-scope text-caption text-subtle" },
        voice.scope && h("span", { className: "bv-truncate", title: voice.scope }, voice.scope),
        watching > 0 && h(
          "span",
          { title: voice.watches.map((w) => `${w.channelName}: ${w.label}`).join("\n") },
          `${voice.scope ? "\xB7 " : ""}Watching ${watching} ${watching === 1 ? "thread" : "threads"}`
        )
      ),
      h(
        "div",
        { className: "bv-log", ref: log, role: "log", "aria-live": "polite" },
        !voice.ready && voice.log.length === 0 ? h(Setup, { voice }) : voice.log.length === 0 && !voice.pending ? h(EmptyState, {
          icon: "mic",
          title: "Talk to Buzz",
          description: "\u201CIn ops, tell build-bot to rerun the deploy.\u201D \u201CAdd a todo in ops for build-bot to rotate the keys.\u201D \u201CHow is work going in ops?\u201D \u201CWhat\u2019s in my inbox?\u201D"
        }) : null,
        voice.log.map((entry) => h(Turn, { key: entry.id, entry })),
        voice.pending && h(Confirm, { voice })
      ),
      h(
        "div",
        { className: "bv-footer" },
        h("div", { className: "bv-meter", "aria-hidden": true }, h("span", { style: { width: `${Math.round(level * 100)}%` } })),
        voice.ready && voice.engine?.runtime && h(HandsFree, { voice }),
        h(TalkButton, { voice }),
        h(
          "p",
          { className: `bv-status text-caption ${voice.statusBad ? "text-danger" : "text-subtle"}`, role: voice.statusBad ? "alert" : "status" },
          voice.status || (voice.ready ? "Or press \u2318\u21E7Space anywhere in Buzz, \u2318\u21E7H for hands-free" : "")
        ),
        h(
          "form",
          {
            className: "bv-type",
            onSubmit: (event) => {
              event.preventDefault();
              controller.submitText(typed);
              setTyped("");
            }
          },
          h(Input, {
            "aria-label": "Type a command",
            placeholder: "Or type what you would say",
            value: typed,
            disabled: voice.busy,
            onChange: (event) => setTyped(event.target.value)
          }),
          h(Button, { type: "submit", variant: "subtle", disabled: voice.busy || !typed.trim() }, "Send")
        )
      )
    );
  }
  function FlagPicker({ flag, mine, palette, onToggle }) {
    const [custom, setCustom] = useState("");
    const choices = [.../* @__PURE__ */ new Set([...flag.emoji, ...palette])];
    return h(
      "div",
      { className: "bv-flag-picker", role: "group", "aria-label": "Your flags on this thread" },
      choices.map(
        (e) => h(
          Button,
          { key: e, variant: mine.includes(e) ? "prominent" : "subtle", size: "sm", "aria-pressed": mine.includes(e), title: mine.includes(e) ? "Unflag" : "Flag", onClick: () => onToggle(e) },
          e
        )
      ),
      h(
        "form",
        {
          className: "bv-row",
          onSubmit: (event) => {
            event.preventDefault();
            const value = custom.replace(/\uFE0F/g, "").trim();
            if (!value) return;
            if (!mine.includes(value)) onToggle(value);
            setCustom("");
          }
        },
        h(Input, { "aria-label": "Other emoji", placeholder: "Other", value: custom, maxLength: 16, style: { width: "5rem" }, onChange: (event) => setCustom(event.target.value) }),
        h(Button, { type: "submit", variant: "subtle", size: "sm", disabled: !custom.trim() }, "Add")
      )
    );
  }
  function Flags({ relay, cacheKey }) {
    const voice = useVoice();
    const cached = flagCache?.key === cacheKey ? flagCache.source : null;
    const [source, setSourceState] = useState(cached ?? emptyFlagSource());
    const [status, setStatus2] = useState(cached ? "" : "loading");
    const [mineOnly, setMineOnlyState] = useState(view.mineOnly);
    const [emoji, setEmojiState] = useState(view.emoji);
    const [open, setOpen] = useState(view.open);
    const [error, setError] = useState("");
    const scroller = useRef(null);
    const setSource = useCallback(
      (next) => {
        flagCache = { key: cacheKey, source: next };
        setSourceState(next);
      },
      [cacheKey]
    );
    const setMineOnly = (next) => {
      saveView({ mineOnly: next });
      setMineOnlyState(next);
    };
    const setEmoji = (next) => {
      saveView({ emoji: next });
      setEmojiState(next);
    };
    const toggleOpen = (rootId) => {
      const next = open === rootId ? null : rootId;
      view.open = next;
      setOpen(next);
    };
    const load = useCallback(() => {
      setStatus2((current) => current === "loading" ? current : "refreshing");
      loadFlags(relay).then((next) => {
        setSource(overlay(next));
        setStatus2("");
      }).catch((error2) => setStatus2(`Could not read reactions: ${error2?.message ?? error2}`));
    }, [relay, setSource]);
    useEffect(() => {
      load();
      const timer = setInterval(load, FLAG_REFRESH_MS);
      return () => clearInterval(timer);
    }, [load]);
    const ready = status !== "loading";
    useEffect(() => {
      if (ready && scroller.current) scroller.current.scrollTop = view.scroll;
    }, [ready]);
    const toggleFlag = (flag, e) => {
      setError("");
      try {
        const current = flagCache?.key === cacheKey ? flagCache.source : source;
        const existing = myFlags(current, flag.rootId).filter((event) => emojiOfFlag(event) === e);
        if (existing.length) {
          relay.unreact(existing, flag.channelId);
          const ids = new Set(existing.map((event) => event.id));
          for (const id of ids) pending.removed.set(id, Date.now());
          setSource(withoutReactions(current, ids));
        } else {
          const target = current.messages.get(flag.rootId) ?? current.messages.get(flag.messageId);
          if (!target) throw new Error("That thread is not loaded yet.");
          const reaction = relay.react(target, e);
          pending.added.set(reaction.id, { event: reaction, at: Date.now() });
          setSource(withReaction(current, reaction));
        }
      } catch (cause) {
        setError(cause?.message ?? String(cause));
      }
    };
    const channelNames = useMemo(() => new Map(relay.channels().map((c) => [c.id, c.name])), [relay, source]);
    const counts = useMemo(() => emojiCounts(source, mineOnly), [source, mineOnly]);
    const total = useMemo(() => groupFlags(source, channelNames, { mineOnly, emoji: null }).length, [source, channelNames, mineOnly]);
    const flags = useMemo(() => groupFlags(source, channelNames, { mineOnly, emoji }), [source, channelNames, mineOnly, emoji]);
    const palette = useMemo(() => [.../* @__PURE__ */ new Set([...DEFAULT_FLAGS, ...counts.map(([e]) => e)])], [counts]);
    const canFlag = relay.canReact();
    const failed = status && status !== "loading" && status !== "refreshing";
    return h(
      Fragment,
      null,
      h(
        "div",
        { className: "bv-bar", style: { paddingTop: 0 } },
        h(Segmented, {
          label: "Whose flags",
          compact: true,
          value: mineOnly ? "mine" : "everyone",
          options: [
            ["everyone", "Everyone"],
            ["mine", "Mine"]
          ],
          onChange: (v) => setMineOnly(v === "mine")
        }),
        h("span", { style: { flex: 1 } }),
        h(IconButton, { label: "Refresh", icon: "refresh", disabled: status === "refreshing" || status === "loading", onClick: load })
      ),
      h(
        "div",
        { className: "bv-bar", role: "radiogroup", "aria-label": "Emoji", style: { paddingTop: 0 } },
        h(Button, { variant: emoji === null ? "prominent" : "subtle", size: "sm", role: "radio", "aria-checked": emoji === null, onClick: () => setEmoji(null) }, `All ${total}`),
        counts.map(
          ([e, count]) => h(
            Button,
            {
              key: e,
              variant: emoji === e ? "prominent" : "subtle",
              size: "sm",
              role: "radio",
              "aria-checked": emoji === e,
              onClick: () => setEmoji(emoji === e ? null : e)
            },
            `${e} ${count}`
          )
        )
      ),
      error && h("p", { className: "text-caption text-danger", role: "alert", style: { margin: 0, padding: "0 var(--space-panel-inset)" } }, error),
      h(
        "div",
        {
          className: "bv-scroll",
          ref: scroller,
          onScroll: (event) => {
            view.scroll = event.currentTarget.scrollTop;
          }
        },
        status === "loading" ? h("p", { className: "text-body-sm text-subtle" }, "Reading reactions...") : failed ? h("p", { className: "text-body-sm text-danger", role: "alert" }, status) : flags.length === 0 ? h(EmptyState, { icon: "flag", title: "No flagged threads", description: mineOnly ? "Threads you react to show up here." : "Threads with reactions show up here." }) : h(
          "ul",
          { className: "bv-flags" },
          flags.map((flag) => {
            const following = voice.watches.some((w) => w.rootId === flag.rootId);
            const mine = [...new Set(myFlags(source, flag.rootId).map(emojiOfFlag))];
            const picking = open === flag.rootId;
            return h(
              "li",
              { key: flag.rootId, className: "bv-flag" },
              h(
                "div",
                { className: "bv-flag-main" },
                h(
                  "button",
                  { type: "button", className: "bv-flag-open", onClick: () => openTarget(flag.channelId, flag.messageId, flag.rootId) },
                  h("span", { className: "bv-flag-emoji" }, flag.emoji.join("")),
                  h(
                    "span",
                    { className: "bv-flag-text" },
                    h("span", { className: "text-label-sm text-standard bv-truncate" }, flag.title),
                    flag.excerpt && h("span", { className: "text-body-sm text-subtle bv-truncate" }, flag.excerpt),
                    h("span", { className: "text-caption text-subtle bv-truncate" }, `#${flag.channelName} \xB7 ${flag.who.join(", ")} \xB7 ${ago(flag.at)}`)
                  )
                ),
                h(
                  "span",
                  { className: "bv-flag-side" },
                  canFlag && h(IconButton, {
                    label: picking ? "Close flags" : mine.length ? `Your flags: ${mine.join(" ")}` : "Flag or unflag",
                    icon: "flag",
                    "aria-expanded": picking,
                    "data-mine": mine.length ? "" : void 0,
                    onClick: () => toggleOpen(flag.rootId)
                  }),
                  h(
                    Button,
                    {
                      variant: following ? "prominent" : "subtle",
                      size: "sm",
                      "aria-pressed": following,
                      onClick: () => following ? controller.unwatch(flag.rootId) : controller.watch({
                        rootId: flag.rootId,
                        channelId: flag.channelId,
                        channelName: flag.channelName,
                        label: flag.title,
                        since: Math.floor(Date.now() / 1e3)
                      })
                    },
                    following ? "Following" : "Follow"
                  )
                )
              ),
              picking && h(FlagPicker, { flag, mine, palette, onToggle: (e) => toggleFlag(flag, e) })
            );
          })
        )
      )
    );
  }
  function Page() {
    const connection = useConnection();
    const voice = useVoice();
    const [tab, setTabState] = useState(view.tab);
    const setTab = (next) => {
      saveView({ tab: next });
      setTabState(next);
    };
    const relay = useMemo(
      () => connection.status === "ready" ? deps.relay() : null,
      [connection.scope, connection.generation, connection.status]
    );
    useEffect(() => {
      if (connection.status === "ready") connection.session?.channels?.ensureList?.();
    }, [connection.session]);
    const online = connection.status === "ready" ? "online" : connection.status === "error" ? "error" : "offline";
    return h(
      "div",
      { className: "h-full min-h-0", style: { height: "100%", minHeight: 0 } },
      h("style", null, CSS),
      h(
        "section",
        { "data-buzz-surface": "", "data-shape": "panel", className: "panel", "aria-label": "Buzz Voice", style: { height: "100%" } },
        h(
          "div",
          { "data-buzz-ui": "", className: "bv-root" },
          h(
            "header",
            { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
            h(
              "div",
              { className: "panel-header-title" },
              h(
                "div",
                { className: "panel-header-label" },
                h("span", { className: "panel-header-label-icon", "aria-hidden": true }, h(Icon, { name: "mic", size: "1rem" })),
                h("h2", null, "Buzz Voice"),
                h("span", { className: "bv-dot", "data-state": online, title: online === "online" ? "Connected" : connection.error || "Connecting" })
              )
            ),
            h(
              "div",
              { className: "panel-header-actions" },
              h(IconButton, { label: "Stop speaking", icon: "speakerOff", onClick: () => controller.stopSpeaking() }),
              h(IconButton, { label: "New session", icon: "plus", onClick: () => controller.newSession() }),
              h(IconButton, { label: "Buzz Voice settings", icon: "gear", onClick: openSettings })
            )
          ),
          h(
            "div",
            { className: "bv-bar" },
            h(Segmented, {
              label: "Buzz Voice",
              value: tab,
              options: [
                ["talk", "Talk"],
                ["flags", "Flags"]
              ],
              onChange: setTab
            })
          ),
          h(
            "div",
            { className: "bv-body" },
            connection.status !== "ready" || !relay ? h(
              "div",
              { className: "bv-scroll" },
              h(EmptyState, {
                icon: "mic",
                title: connection.status === "error" ? "Could not connect" : "Connecting",
                description: connection.status === "error" ? connection.error ?? "Buzz could not reach the community." : "Waiting for the community connection."
              })
            ) : tab === "talk" ? h(Talk, { voice }) : h(Flags, { key: `${connection.scope}:${connection.generation}`, cacheKey: `${connection.scope}:${connection.generation}`, relay })
          )
        )
      )
    );
  }
  function LlmForm({ settings }) {
    const [draft, setDraft] = useState({ llmUrl: settings.llmUrl, llmModel: settings.llmModel, llmKey: settings.llmKey });
    const [saved, setSaved] = useState(false);
    useEffect(() => {
      setDraft({ llmUrl: settings.llmUrl, llmModel: settings.llmModel, llmKey: settings.llmKey });
    }, [settings.llmUrl, settings.llmModel, settings.llmKey]);
    const dirty = draft.llmUrl !== settings.llmUrl || draft.llmModel !== settings.llmModel || draft.llmKey !== settings.llmKey;
    const invalid = draft.llmUrl.trim() !== "" && !/^https?:\/\/[^\s]+$/i.test(draft.llmUrl.trim());
    const set = (key) => (event) => {
      setSaved(false);
      setDraft({ ...draft, [key]: event.target.value });
    };
    return h(
      Group,
      { layout: "form" },
      h(
        "form",
        {
          className: "bv-form",
          noValidate: true,
          onSubmit: (event) => {
            event.preventDefault();
            if (invalid) return;
            controller.updateSettings({ llmUrl: draft.llmUrl.trim(), llmModel: draft.llmModel.trim(), llmKey: draft.llmKey.trim() });
            setSaved(true);
          }
        },
        h(
          Field,
          { label: "Endpoint", description: invalid ? void 0 : "OpenAI-compatible base URL, http or https." },
          h(Input, { value: draft.llmUrl, onChange: set("llmUrl"), placeholder: "http://localhost:4000/v1", spellCheck: false, autoCapitalize: "off", autoCorrect: "off" })
        ),
        invalid && h("p", { className: "buzz-field-error text-caption text-danger", role: "alert", style: { margin: 0 } }, "Enter a URL starting with http:// or https://."),
        h(Field, { label: "Model" }, h(Input, { value: draft.llmModel, onChange: set("llmModel"), placeholder: "default", spellCheck: false })),
        h(
          Field,
          { label: "API key", description: "Optional. Stored on this device only." },
          h(Input, { type: "password", value: draft.llmKey, onChange: set("llmKey"), autoComplete: "off" })
        ),
        h(
          "div",
          { className: "bv-row-end", style: { marginTop: "var(--space-2)" } },
          saved && !dirty && h("span", { className: "text-caption text-subtle", style: { marginRight: "auto" } }, "Saved"),
          h(
            Button,
            {
              variant: "subtle",
              disabled: !dirty,
              onClick: () => {
                setDraft({ llmUrl: settings.llmUrl, llmModel: settings.llmModel, llmKey: settings.llmKey });
              }
            },
            "Discard"
          ),
          h(Button, { type: "submit", variant: "prominent", disabled: !dirty || invalid }, "Save")
        )
      )
    );
  }
  function SpeechForm({ settings }) {
    const [draft, setDraft] = useState({ modelDir: settings.modelDir, whisper: settings.whisper });
    useEffect(() => setDraft({ modelDir: settings.modelDir, whisper: settings.whisper }), [settings.modelDir, settings.whisper]);
    const dirty = draft.modelDir !== settings.modelDir || draft.whisper !== settings.whisper;
    return h(
      "form",
      {
        className: "bv-form",
        noValidate: true,
        onSubmit: (event) => {
          event.preventDefault();
          controller.updateSettings({ modelDir: draft.modelDir.trim() || "~/buzz-voice-models", whisper: draft.whisper.trim() || "small.en" });
          void controller.refreshEngine();
        }
      },
      h(Field, { label: "Model folder" }, h(Input, { value: draft.modelDir, onChange: (e) => setDraft({ ...draft, modelDir: e.target.value }), spellCheck: false })),
      h(
        Field,
        { label: "Whisper model", description: "small.en matches the Buzz Voice app. base.en and tiny.en are faster and less accurate." },
        h(Input, { value: draft.whisper, onChange: (e) => setDraft({ ...draft, whisper: e.target.value }), spellCheck: false })
      ),
      dirty && h(
        "div",
        { className: "bv-row-end" },
        h(Button, { variant: "subtle", onClick: () => setDraft({ modelDir: settings.modelDir, whisper: settings.whisper }) }, "Discard"),
        h(Button, { type: "submit", variant: "prominent" }, "Save")
      )
    );
  }
  function MicrophonePicker({ value }) {
    const [devices, setDevices] = useState([]);
    useEffect(() => {
      let live = true;
      const load = () => void listMicrophones().then((list2) => live && setDevices(list2)).catch(() => void 0);
      load();
      navigator.mediaDevices?.addEventListener?.("devicechange", load);
      return () => {
        live = false;
        navigator.mediaDevices?.removeEventListener?.("devicechange", load);
      };
    }, []);
    return h(
      "select",
      {
        "aria-label": "Microphone",
        "data-buzz-ui": "",
        className: "buzz-input",
        "data-size": "md",
        style: { width: "14rem", maxWidth: "100%" },
        value,
        onChange: (e) => controller.updateSettings({ microphone: e.target.value })
      },
      h("option", { value: "" }, "System default"),
      devices.map((d) => h("option", { key: d.id, value: d.id }, d.label)),
      value && !devices.some((d) => d.id === value) && h("option", { value }, "Saved microphone (not connected)")
    );
  }
  function SettingsCard() {
    const voice = useVoice();
    const settings = voice.settings;
    const engine = voice.engine;
    const status = voice.installing ? `${voice.installing}...` : voice.engineError ? voice.engineError : !engine ? "Checking..." : engine.engine && engine.model ? `Ready. Whisper ${settings.whisper}, transcribed on this device.` : `Missing ${[!engine.engine && "the engine", !engine.model && "the model"].filter(Boolean).join(" and ")}.`;
    const ready = !!engine?.engine && !!engine?.model;
    return h(
      "section",
      { className: "bv-settings", "aria-labelledby": "bv-settings-title" },
      h("style", null, CSS),
      h(Header, { title: "Buzz Voice", subtitle: "Talk to Buzz and find threads by emoji." }),
      h(Header, { inline: true, title: "Speech to text" }),
      h(
        Group,
        null,
        h(Row, {
          title: "Speech engine",
          subtitle: h("span", { className: voice.engineError ? "text-danger" : void 0 }, status),
          trailing: h(
            Button,
            {
              variant: ready ? "subtle" : "prominent",
              size: "sm",
              loading: !!voice.installing,
              onClick: () => void (ready ? controller.refreshEngine() : controller.install())
            },
            ready ? "Check" : "Install"
          )
        })
      ),
      h(
        Group,
        null,
        h(Row, {
          title: "Fast speech and hands-free",
          subtitle: engine?.runtime ? "Ready. Whisper stays loaded between sentences, and hands-free listens for the wake word." : "Keeps whisper loaded so replies start sooner, and turns on hands-free. Needs python3; installs into the model folder.",
          trailing: engine?.runtime ? h(Switch, { label: "Hands-free", checked: voice.handsFree, onChange: () => controller.toggleHandsFree() }) : h(Button, { variant: "subtle", size: "sm", loading: !!voice.installing, disabled: !ready, onClick: () => void controller.install() }, "Install")
        }),
        h(Row, {
          title: "Wake word",
          subtitle: `Say \u201Chey ${settings.wakeWord.trim() || "buzz"}, ...\u201D to give a command hands-free.`,
          trailing: h(Input, {
            "aria-label": "Wake word",
            value: settings.wakeWord,
            placeholder: "buzz",
            style: { width: "10rem" },
            onChange: (e) => controller.updateSettings({ wakeWord: e.target.value })
          })
        })
      ),
      h(Group, { layout: "form" }, h(SpeechForm, { settings })),
      h(Header, {
        inline: true,
        title: "Language model",
        subtitle: "Writes messages and reads channels back. Routing uses your Decisions API provider when one is on."
      }),
      h(LlmForm, { settings }),
      h(Header, { inline: true, title: "Microphone" }),
      h(Group, null, h(Row, { title: "Input", subtitle: "The microphone stays open while you use Buzz Voice, so talking starts instantly. It closes after 10 idle minutes.", trailing: h(MicrophonePicker, { value: settings.microphone }) })),
      h(Header, { inline: true, title: "Spoken replies" }),
      h(
        Group,
        null,
        h(Row, {
          title: "Read replies out loud",
          subtitle: "Answers and new replies in watched threads.",
          trailing: h(Switch, { label: "Read replies out loud", checked: settings.speak, onChange: (next) => controller.updateSettings({ speak: next }) })
        }),
        h(Row, {
          title: "Voice",
          subtitle: "A macOS voice name. Blank uses the system voice.",
          trailing: h(Input, {
            "aria-label": "Voice",
            value: settings.voice,
            placeholder: "System",
            style: { width: "10rem" },
            onChange: (e) => controller.updateSettings({ voice: e.target.value })
          })
        })
      ),
      h(Header, { inline: true, title: "Shortcuts" }),
      h(
        Group,
        null,
        h(Row, { title: "Start or stop talking", trailing: h("kbd", { className: "bv-kbd text-caption" }, "\u2318\u21E7Space") }),
        h(Row, { title: "Stop speaking", trailing: h("kbd", { className: "bv-kbd text-caption" }, "\u2318\u21E7.") }),
        h(Row, { title: "Hands-free on or off", trailing: h("kbd", { className: "bv-kbd text-caption" }, "\u2318\u21E7H") })
      )
    );
  }
  return { Page, SettingsCard };
}

// src/index.ts
var inject = ["react", "pages", "relay", "navigation", "host", "shortcuts", "settingsCards"];
function optional(ctx, name) {
  try {
    return ctx.reflect?.get?.(name) ?? ctx.get?.(name) ?? ctx[name];
  } catch {
    return void 0;
  }
}
function apply(ctx) {
  let cached = null;
  const relay = () => {
    const connection = ctx.relay.snapshot();
    if (connection.status !== "ready" || !connection.session || !connection.viewer) return null;
    const key = `${connection.scope}:${connection.generation}`;
    if (cached?.key !== key) {
      connection.session.channels?.ensureList?.();
      cached = { key, relay: new Relay(connection.session, connection.viewer) };
    }
    return cached.relay;
  };
  const decide = () => {
    const decisions = optional(ctx, "decisions");
    return decisions?.decide ? (request) => decisions.decide(request) : null;
  };
  const controller = new Controller({
    host: ctx.host,
    relay,
    decide,
    community: () => scopeOf(ctx.relay.snapshot())?.communityOrigin
  });
  ctx.effect(() => controller.start(), "buzz-voice controller");
  const { Page, SettingsCard } = createUi({
    React: ctx.react,
    controller,
    relayService: ctx.relay,
    relay,
    navigation: ctx.navigation
  });
  ctx.pages.register({ id: "main", title: "Buzz Voice", primary: true, component: Page });
  ctx.settingsCards.register({ id: "settings", title: "Buzz Voice", component: SettingsCard, personal: true });
  ctx.shortcuts.register({
    id: "talk",
    title: "Buzz Voice: start or stop talking",
    binding: { key: " ", mod: true, shift: true },
    allowInEditable: true,
    run: () => {
      void controller.toggleListening();
    }
  });
  ctx.shortcuts.register({
    id: "hands-free",
    title: "Buzz Voice: hands-free on or off",
    binding: { key: "h", mod: true, shift: true },
    allowInEditable: true,
    run: () => controller.toggleHandsFree()
  });
  ctx.shortcuts.register({
    id: "stop-speaking",
    title: "Buzz Voice: stop speaking",
    binding: { key: ".", mod: true, shift: true },
    allowInEditable: true,
    run: () => controller.stopSpeaking()
  });
}
export {
  apply,
  inject
};
