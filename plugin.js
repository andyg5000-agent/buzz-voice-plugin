// Built from src/ by build.mjs. Edit the TypeScript, then run npm run build.

// src/engine.ts
var DEFAULT_SETTINGS = {
  modelDir: "~/buzz-voice-models",
  whisper: "small.en",
  llmUrl: "",
  llmModel: "",
  llmKey: "",
  voice: "",
  speak: true,
  microphone: ""
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
function parseStatus(stdout) {
  const at = stdout.indexOf('{"engine"');
  if (at < 0) throw new Error("The setup script returned nothing.");
  const parsed = JSON.parse(stdout.slice(at).trim());
  return { engine: !!parsed.engine, model: !!parsed.model, buzzVoice: parsed.buzzVoice ?? null };
}
async function checkEngine(host, settings) {
  const result = await run(host, "setup", [settings.modelDir, "check", settings.whisper]);
  return parseStatus(result.stdout);
}
async function installEngine(host, settings, progress) {
  const result = await run(host, "setup", [settings.modelDir, "install", settings.whisper], "", (line2) => {
    if (line2.startsWith("progress ")) progress(line2.slice(9));
  });
  if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").pop() || "Install failed.");
  return parseStatus(result.stdout);
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
var Speaker = class {
  constructor(host, settings) {
    this.host = host;
    this.settings = settings;
  }
  current = null;
  queue = Promise.resolve();
  speak(text) {
    const settings = this.settings();
    if (!settings.speak) return;
    const clean2 = text.replace(/^[\s-]+/, "").trim();
    if (!clean2) return;
    this.queue = this.queue.then(() => this.say(clean2, settings)).catch(() => void 0);
  }
  async say(text, settings) {
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
    await new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      speechSynthesis.speak(utterance);
    });
  }
  stop() {
    this.queue = Promise.resolve();
    void this.current?.kill();
    this.current = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }
};
var TARGET_RATE = 16e3;
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
          this.prerollSamples -= this.preroll.shift().length;
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
  armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.capturing) this.release();
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
    return { base64: toBase64(wav(pcm, TARGET_RATE)), seconds: pcm.length / TARGET_RATE, peak };
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
  const text = (offset, value) => {
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
function digits(text) {
  const words = text.split(/\s+/);
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const tens = TENS[word];
    if (tens !== void 0) {
      const next = ONES[words[i + 1] ?? ""];
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
function canon(text) {
  return digits(text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim()).replace(/[^a-z0-9]+/g, "").replace(/(.)\1+/g, "$1");
}
function distance(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = row;
  }
  return previous[b.length];
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
function fold(text) {
  return canon(text).split("").map((ch) => /[0-9]/.test(ch) ? ch : CLASS[ch] ?? "").join("").replace(/(.)\1+/g, "$1");
}
function variants(rawName) {
  const words = rawName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return [...new Set(words.filter((word) => word.length > 2))];
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
function hits(pattern, text) {
  const found = [];
  pattern.lastIndex = 0;
  let hit = pattern.exec(text);
  while (hit) {
    if (hit[1]?.trim()) found.push(hit[1].trim());
    hit = pattern.exec(text);
  }
  return found;
}
function channelPhrases(text) {
  const explicit = [...hits(BEFORE_CHANNEL, text), ...hits(AFTER_CHANNEL, text)];
  if (explicit.length > 0) return explicit;
  const loose = hits(CUE, text);
  return loose.length > 0 ? loose : [text];
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
      enum: ["post", "status", "inbox", "unknown"],
      description: "post when the speaker is assigning work or sending a message, status when they are asking about work in a channel, inbox when they ask about their inbox, unreads, notifications or what is waiting on them."
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
      description: `The message to post, as a direct instruction addressed to nobody. Keep the speaker's own wording and their domain terms verbatim. Strip the routing framing: the thread or channel the speaker picked out, and any "tell NAME", "tell NAME to" or "ask NAME to" wrapper. The recipient is tagged separately, so naming them here says it twice. From "in the thread about the login bug in ops tell build-bot that the fix is live" the instruction is "The fix is live." Empty for status actions.`
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
  const text = value?.trim();
  if (!text) return null;
  return ["null", "none", "unknown", "n/a"].includes(text.toLowerCase()) ? null : text;
}
function firstJson(text) {
  const trimmed = text.trim();
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
    const text = message2?.tool_calls?.[0]?.function?.arguments ?? message2?.content ?? "";
    const value = firstJson(String(text));
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
function short(text, fallback) {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return (flat || fallback).slice(0, 200);
}
async function decideRoute(decide, community, transcript, channels, people, scope, previous) {
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
        inbox: "The speaker is asking about their own unread messages or notifications."
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
    scope.threads.forEach((thread2, index) => {
      threadOptions[String(index + 1)] = short(thread2.label, `Thread ${index + 1}.`);
    });
    threadOptions[NO_THREAD] = "They described no particular thread.";
    questions.thread = {
      type: "choice",
      instructions: "The speaker may have picked out one of the threads already in scope, by number or by what it is about. Which one?",
      options: threadOptions
    };
  }
  if (previous) {
    questions.continues = {
      type: "yes_no",
      instructions: "The speaker is building on the previous exchange rather than starting something new."
    };
  }
  const state = previous ? `Previous exchange: ${previous}

Spoken now: ${transcript}` : `Spoken now: ${transcript}`;
  const result = await decide({ state, questions, timeoutMs: 15e3, community });
  if (result.outcome !== "answered") return null;
  const answers = result.answers;
  const action = choiceOf(answers, "action");
  const channel = choiceOf(answers, "channel");
  const recipient = choiceOf(answers, "recipient");
  const thread = choiceOf(answers, "thread");
  const filter = choiceOf(answers, "filter");
  const ref = thread && thread !== NO_THREAD ? Number(thread) : NaN;
  return {
    action: action === "status" || action === "inbox" ? action : "post",
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
      (thread, index) => `  ${index + 1}. ${thread.label}${thread.who.length ? ` (${thread.who.join(", ")})` : ""}`
    )
  ];
  if (scope.focus) {
    const index = scope.threads.findIndex((t) => t.rootId === scope.focus?.rootId);
    if (index >= 0) {
      lines.push(
        `Thread ${index + 1} is the one just read back or posted to. "that thread" and "in there" mean it.`
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
    const words = llm ? wordsOnly(llm, transcript, turns).catch(() => ({})) : null;
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
      const said = words ? await words : {};
      const recipient2 = clean(routed.recipient);
      return {
        action: routed.action,
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
    if (words) await words;
  }
  if (!llm) throw new Error("Routing needs a Decisions provider or an LLM. Set one up in Settings.");
  const list = channels.map((c) => `${c.name}: ${c.description || "no description"}`).join("\n");
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
    "The inbox is what is unread and waiting on the speaker across every channel.",
    '"my inbox", "unreads", "notifications", "what is waiting on me" and',
    '"anything for me" are action inbox with channel null. Inbox is never a',
    "channel name, whatever the channels are called.",
    "Answer with one JSON object and nothing else.",
    "Channels:",
    list,
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
  let text = instruction.trim();
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
    const before = text;
    for (const pattern of patterns) text = text.replace(pattern, "").trim();
    text = stripSpokenName(text, recipient);
    if (text === before) break;
  }
  if (!text) return instruction.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function stripSpokenName(text, recipient) {
  if (!recipient) return text;
  const lead = /^(?:and\s+)?(?:please\s+)?(?:tell|ask|let)\s+/i.exec(text);
  if (!lead) return text;
  const words = text.slice(lead[0].length).split(/\s+/);
  const wanted = canon(recipient);
  for (let take = Math.min(5, words.length); take >= 1; take -= 1) {
    if (canon(words.slice(0, take).join(" ")) !== wanted) continue;
    return words.slice(take).join(" ").replace(/^(?:that|to|know\s+that|know)\s+/i, "").trim();
  }
  return text;
}
async function pickThread(options) {
  const { llm, decide, community, channelName, hint, transcript, labels } = options;
  if (labels.length === 0) return null;
  if (decide) {
    const opts = {};
    labels.forEach((label, index) => {
      opts[String(index + 1)] = short(label, `Thread ${index + 1}.`);
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
          ...labels.map((label, index) => `  ${index + 1}. ${label}`),
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

// src/types.ts
function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}
function rootOf(event) {
  const marked = event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1];
  return marked ?? event.tags.find((tag) => tag[0] === "e" && tag[1])?.[1] ?? event.id;
}
function plain(text) {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/nostr:\S+/g, "").replace(/[*_~`]+/g, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
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
  const index = scope.threads.findIndex((t) => t.rootId === scope.focus?.rootId);
  const number = index >= 0 ? `${index + 1}` : "?";
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
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function mentionsIn(body, members) {
  return members.filter((member) => new RegExp(`@${escapeRe(member.name)}(?![\\w-])`, "i").test(body));
}
function block(thread, index, names) {
  const lines = thread.messages.slice(-12).map((event) => {
    const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
    const when = new Date(event.created_at * 1e3).toLocaleString();
    return `  ${who} (${when}): ${event.content.replace(/\s+/g, " ").slice(0, 600)}`;
  });
  return [`Thread ${index + 1}:`, ...lines].join("\n");
}
function spoken(who, channelName, content) {
  const body = content.replace(/```[\s\S]*?```/g, " a code block ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " a link ").replace(/nostr:\S+/g, " ").replace(/^@\S+\s*/, "").replace(/[*_~`#>|]+/g, "").replace(/\s+/g, " ").trim();
  const cut = body.length > 420 ? `${body.slice(0, 420).replace(/\s\S*$/, "")}...` : body;
  return `${who} in ${channelName}. ${cut}`;
}
var Controller = class {
  constructor(deps) {
    this.deps = deps;
    this.speaker = new Speaker(deps.host, () => this.state.settings);
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
      routing: ""
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
    void this.refreshEngine();
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.recorder.release();
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
    if (patch.microphone !== void 0 && patch.microphone !== this.state.settings.microphone) this.recorder.release();
    saveSettings(settings);
    this.set({ settings });
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
  say(role, text, extra = {}) {
    const entry = { id: this.nextId++, role, text, ...extra };
    this.set({ log: [...this.state.log, entry].slice(-MAX_LOG) });
    this.history.push({ role, text });
    if (this.history.length > HISTORY_TURNS) this.history.splice(0, this.history.length - HISTORY_TURNS);
  }
  reply(text, opts = {}) {
    this.say("app", text, { bad: opts.bad });
    this.setStatus(opts.bad ? text : "", opts.bad);
    this.speaker.speak(text);
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
      const text = await transcribe(this.deps.host, this.state.settings, audio.base64);
      if (!text || /^\[?(blank_audio|silence)\]?$/i.test(text)) {
        this.setStatus("I did not catch that.");
        return;
      }
      this.setStatus("");
      await this.handleTranscript(text);
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
  submitText(text) {
    const trimmed = text.trim();
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
  async handleTranscript(text) {
    this.say("you", text);
    const relay = this.deps.relay();
    if (!relay) {
      this.reply("Buzz is not connected yet.", { bad: true });
      return;
    }
    if (this.awaitingYesNo && this.state.pending) {
      this.awaitingYesNo = false;
      if (/\b(yes|yep|yeah|send it|do it|go ahead|confirm|sure)\b/i.test(text)) await this.publish();
      else if (/\b(no|nope|cancel|stop|never ?mind|don'?t)\b/i.test(text)) this.cancel();
      else {
        this.cancel();
        await this.route(relay, text);
      }
      return;
    }
    await this.route(relay, text);
  }
  async route(relay, text) {
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
        transcript: text,
        channels,
        people,
        scope: this.scope,
        turns: this.history.slice(0, -1)
      });
      if (!live()) return;
      if (intent.action === "inbox") return await this.readInbox(relay, text);
      const named = matchChannel(channels, intent.channel, text);
      const referenced = threadByRef(this.scope, intent.thread_ref);
      const byRef = referenced ? channels.find((c) => c.id === referenced.channelId) ?? null : null;
      const staying = intent.continues_previous || intent.thread === "existing";
      const channel = named ?? byRef ?? (staying ? this.scope.channel : null);
      if (intent.action === "status") {
        if (channel) {
          const target2 = named && named.id !== this.scope.channel?.id ? null : resolveThread(this.scope, channel, intent.thread_ref);
          if (target2 && (intent.thread === "existing" || intent.thread_ref !== null)) {
            return await this.readThread(relay, channel, target2, text);
          }
          return await this.readChannel(relay, channel, text);
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
      const target = intent.new_thread ? null : resolveThread(this.scope, channel, intent.thread_ref) ?? await this.findThread(relay, channel, intent, text);
      if (!live()) return;
      const members = await this.rankedMembers(relay, channel, target?.rootId ?? null);
      if (!live()) return;
      const mention = intent.recipient ? bestPerson(members, (m) => m.name, intent.recipient, text) : null;
      const addressed = mention?.name ?? intent.recipient;
      const body = addressed ? `@${addressed} ${intent.instruction}` : intent.instruction;
      this.set({
        pending: {
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
    const all = await relay.threads(channel.id);
    if (all.length === 0) return null;
    const recent = all.slice(-12);
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
    const all = await relay.threads(channel.id);
    if (all.length === 0) {
      this.scope = setThreads(this.scope, channel, [], null);
      this.paintScope();
      this.reply(`${channel.name} has no messages.`);
      return;
    }
    const recent = all.slice(-8);
    const names = await relay.profiles([...new Set(recent.flatMap((t) => t.messages.map((m) => m.pubkey)))]);
    const blocks = recent.map((thread, index) => block(thread, index, names));
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
    const messages = [...root, ...replies].filter((event, index, list) => list.findIndex((e) => e.id === event.id) === index).sort((a, b) => a.created_at - b.created_at);
    if (messages.length === 0) return this.readChannel(relay, channel, question);
    const names = await relay.profiles([...new Set(messages.map((m) => m.pubkey))]);
    const one = {
      rootId: thread.rootId,
      messages: messages.slice(-24),
      lastAt: messages[messages.length - 1].created_at
    };
    const answer = await summarizeChannel(this.requireLlm(), channel.name, question, [block(one, 0, names)]);
    this.scope = { ...this.scope, channel, focus: thread };
    this.paintScope();
    this.watch({ rootId: thread.rootId, channelId: channel.id, channelName: channel.name, label: thread.label, since: one.lastAt });
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
    const blocks = unread.map(([, item], index) => {
      const lines = item.events.slice(-4).map((event) => {
        const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
        const when = new Date(event.created_at * 1e3).toLocaleString();
        return `  ${who} (${when}): ${event.content.replace(/\s+/g, " ").slice(0, 600)}`;
      });
      return [`Unread ${index + 1}, in ${channelName(item.channelId)}:`, ...lines].join("\n");
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
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
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
    return [...await this.session.read(filters)];
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
  async allReactions(channelIds, limit = 1e3) {
    const filters = chunk(channelIds, CHUNK).map((ids) => ({ kinds: [KIND_REACTION], "#h": ids, limit }));
    return filters.length ? this.query(filters) : [];
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
function line(text) {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/[*_~`]+/g, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
}
function emptyFlagSource() {
  return { reactions: [], messages: /* @__PURE__ */ new Map(), names: /* @__PURE__ */ new Map(), mine: "" };
}
async function loadFlags(relay) {
  const channelIds = relay.channels().map((c) => c.id);
  const all = await relay.allReactions(channelIds, REACTION_LIMIT);
  const usable = all.filter((event) => emojiOf(event) && emojiOf(event) !== "-" && targetOf(event));
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

// src/ui.ts
var TAP_MS = 400;
var FLAG_REFRESH_MS = 6e4;
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
.bv-flag{display:flex;align-items:flex-start;gap:var(--space-2);border-bottom:1px solid var(--border-standard);padding:var(--space-1) 0}
.bv-flag:last-child{border-bottom:0}
.bv-flag-open{display:flex;gap:var(--space-3);flex:1;min-width:0;padding:var(--space-2);border:0;border-radius:var(--radius-row);background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bv-flag-open:hover{background:var(--affordance-row-hover)}
.bv-flag-emoji{flex:none;min-width:2.75rem;white-space:nowrap;font-size:1.125rem;line-height:1.5rem}
.bv-flag-text{display:flex;flex-direction:column;gap:var(--space-half);min-width:0}
.bv-flag-side{flex:none;padding-top:var(--space-1)}
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
          ([id, text]) => h(
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
            text
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
      description: voice.engineError ? voice.engineError : `Speech is transcribed on this Mac with sherpa-onnx, the same as the Buzz Voice app. ${missing ? `Install ${missing} to start.` : "Checking for the engine..."}`,
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
    const pending = voice.pending;
    const ref = useRef(null);
    useEffect(() => {
      const field = ref.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange?.(field.value.length, field.value.length);
    }, [pending.channel.id, pending.replyTo]);
    useEffect(() => {
      const field = ref.current;
      if (!field) return;
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    }, [pending.body]);
    const found = mentionsIn(pending.body, pending.members);
    const unmatched = found.length === 0 && pending.body.includes("@");
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return h(
      "div",
      { className: "bv-card", role: "group", "aria-label": "Confirm message" },
      h(
        "div",
        { className: "bv-row" },
        h("span", { className: "text-label-sm text-standard" }, `#${pending.channel.name}`),
        pending.label && h("span", { className: "text-caption text-subtle bv-truncate" }, `in \u201C${pending.label}\u201D`)
      ),
      h("textarea", {
        ref,
        "aria-label": "Message to send",
        value: pending.body,
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
      found.length === 0 && pending.members.length > 0 && h(
        "div",
        { className: "bv-row" },
        pending.members.slice(0, 8).map(
          (member) => h(
            Button,
            {
              key: member.pubkey,
              variant: "subtle",
              size: "sm",
              onClick: () => {
                const stripped = pending.addressed ? pending.body.replace(new RegExp(`^\\s*@${escape(pending.addressed)}\\s*`, "i"), "") : pending.body;
                controller.editPending(`@${member.name} ${stripped.trim()}`);
              }
            },
            `@${member.name}`
          )
        )
      ),
      pending.orphaned && h("p", { className: "text-caption text-warning", style: { margin: 0 } }, `No thread open in ${pending.channel.name}, so this posts as a new message.`),
      h(
        "div",
        { className: "bv-row-end" },
        h("span", { className: "text-caption text-subtle", style: { marginRight: "auto" } }, "Enter or say \u201Cyes\u201D to send"),
        h(Button, { variant: "subtle", onClick: () => controller.cancel() }, "Cancel"),
        h(Button, { variant: "prominent", onClick: () => void controller.publish() }, "Send")
      )
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
      const node = log.current;
      if (node) node.scrollTop = node.scrollHeight;
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
          description: "\u201CIn ops, tell build-bot to rerun the deploy.\u201D \u201CHow is work going in ops?\u201D \u201CWhat\u2019s in my inbox?\u201D"
        }) : null,
        voice.log.map((entry) => h(Turn, { key: entry.id, entry })),
        voice.pending && h(Confirm, { voice })
      ),
      h(
        "div",
        { className: "bv-footer" },
        h("div", { className: "bv-meter", "aria-hidden": true }, h("span", { style: { width: `${Math.round(level * 100)}%` } })),
        h(TalkButton, { voice }),
        h(
          "p",
          { className: `bv-status text-caption ${voice.statusBad ? "text-danger" : "text-subtle"}`, role: voice.statusBad ? "alert" : "status" },
          voice.status || (voice.ready ? "Or press \u2318\u21E7Space anywhere in Buzz" : "")
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
  function Flags({ relay }) {
    const voice = useVoice();
    const [source, setSource] = useState(emptyFlagSource());
    const [status, setStatus] = useState("loading");
    const [mineOnly, setMineOnly] = useState(false);
    const [emoji, setEmoji] = useState(null);
    const load = useCallback(() => {
      setStatus((current) => current === "loading" ? current : "refreshing");
      loadFlags(relay).then((next) => {
        setSource(next);
        setStatus("");
      }).catch((error) => setStatus(`Could not read reactions: ${error?.message ?? error}`));
    }, [relay]);
    useEffect(() => {
      load();
      const timer = setInterval(load, FLAG_REFRESH_MS);
      return () => clearInterval(timer);
    }, [load]);
    const channelNames = useMemo(() => new Map(relay.channels().map((c) => [c.id, c.name])), [relay, source]);
    const counts = useMemo(() => emojiCounts(source, mineOnly), [source, mineOnly]);
    const total = useMemo(() => groupFlags(source, channelNames, { mineOnly, emoji: null }).length, [source, channelNames, mineOnly]);
    const flags = useMemo(() => groupFlags(source, channelNames, { mineOnly, emoji }), [source, channelNames, mineOnly, emoji]);
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
      h(
        "div",
        { className: "bv-scroll" },
        status === "loading" ? h("p", { className: "text-body-sm text-subtle" }, "Reading reactions...") : failed ? h("p", { className: "text-body-sm text-danger", role: "alert" }, status) : flags.length === 0 ? h(EmptyState, { icon: "flag", title: "No flagged threads", description: mineOnly ? "Threads you react to show up here." : "Threads with reactions show up here." }) : h(
          "ul",
          { className: "bv-flags" },
          flags.map((flag) => {
            const following = voice.watches.some((w) => w.rootId === flag.rootId);
            return h(
              "li",
              { key: flag.rootId, className: "bv-flag" },
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
            );
          })
        )
      )
    );
  }
  function Page() {
    const connection = useConnection();
    const voice = useVoice();
    const [tab, setTab] = useState("talk");
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
            ) : tab === "talk" ? h(Talk, { voice }) : h(Flags, { key: `${connection.scope}:${connection.generation}`, relay })
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
      const load = () => void listMicrophones().then((list) => live && setDevices(list)).catch(() => void 0);
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
        h(Row, { title: "Stop speaking", trailing: h("kbd", { className: "bv-kbd text-caption" }, "\u2318\u21E7.") })
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
