// Built from src/ by build.mjs. Edit the TypeScript, then run npm run build.

// src/engine.ts
var DEFAULT_SETTINGS = {
  modelDir: "~/buzz-voice-models",
  whisper: "small.en",
  llmUrl: "",
  llmModel: "",
  llmKey: "",
  voice: "",
  speak: true
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
var Recorder = class {
  stream = null;
  context = null;
  node = null;
  chunks = [];
  samples = 0;
  level = 0;
  get active() {
    return this.stream !== null;
  }
  async start(onLevel) {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not available here.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const Context = window.AudioContext ?? window.webkitAudioContext;
    const context = new Context();
    const source = context.createMediaStreamSource(stream);
    const node = context.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.samples = 0;
    node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      if (this.samples < context.sampleRate * MAX_SECONDS) {
        this.chunks.push(new Float32Array(input));
        this.samples += input.length;
      }
      let peak = 0;
      for (let i = 0; i < input.length; i += 16) peak = Math.max(peak, Math.abs(input[i]));
      this.level = peak;
      onLevel(peak);
    };
    source.connect(node);
    node.connect(context.destination);
    this.stream = stream;
    this.context = context;
    this.node = node;
    if (context.state === "suspended") await context.resume();
  }
  async stop() {
    const context = this.context;
    if (!context) return null;
    const rate = context.sampleRate;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await context.close().catch(() => void 0);
    this.stream = null;
    this.context = null;
    this.node = null;
    const merged = new Float32Array(this.samples);
    let at = 0;
    for (const chunk2 of this.chunks) {
      merged.set(chunk2.subarray(0, Math.min(chunk2.length, merged.length - at)), at);
      at += chunk2.length;
      if (at >= merged.length) break;
    }
    this.chunks = [];
    const pcm = resample(merged, rate, TARGET_RATE);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 1) peak = Math.max(peak, Math.abs(pcm[i]));
    return { base64: toBase64(wav(pcm, TARGET_RATE)), seconds: pcm.length / TARGET_RATE, peak };
  }
  cancel() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => void 0);
    this.stream = null;
    this.context = null;
    this.node = null;
    this.chunks = [];
  }
};
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
    const row2 = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row2[j] = Math.min(
        previous[j] + 1,
        row2[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = row2;
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
    for (const item2 of items) {
      const result = scorer(nameOf(item2), phrase);
      if (result === null) continue;
      const better = result < winning || result === winning && canon(nameOf(item2)).length > canon(winner ? nameOf(winner) : "").length;
      if (better) {
        winning = result;
        winner = item2;
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

// src/scope.ts
function emptyScope() {
  return { channel: null, threads: [], focus: null };
}
function describeThread(thread, names) {
  const root = thread.messages[0];
  const label = (root?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 70);
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

// src/types.ts
function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}
function rootOf(event) {
  const marked = event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1];
  return marked ?? event.tags.find((tag) => tag[0] === "e" && tag[1])?.[1] ?? event.id;
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
      this.recorder.cancel();
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
  setStatus(status, bad2 = false) {
    this.set({ status, statusBad: bad2 });
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
    this.speaker.stop();
    try {
      await this.recorder.start((level) => {
        if (this.levelFrame) return;
        this.levelFrame = requestAnimationFrame(() => {
          this.levelFrame = 0;
          this.set({ level });
        });
      });
      this.set({ listening: true, latched: false, status: "Listening...", statusBad: false });
    } catch (error) {
      this.setStatus(`Microphone: ${message(error)}`, true);
    }
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
      const members = await relay.members(channel);
      if (!live()) return;
      const mention = intent.recipient ? bestPerson(members, (m) => m.name, intent.recipient, text) : null;
      const addressed = mention?.name ?? intent.recipient;
      const body = addressed ? `@${addressed} ${intent.instruction}` : intent.instruction;
      const target = intent.new_thread ? null : resolveThread(this.scope, channel, intent.thread_ref) ?? await this.findThread(relay, channel, intent, text);
      if (!live()) return;
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
    const newest = (item2) => item2.events[item2.events.length - 1].created_at;
    const unread = [...byRoot.entries()].filter(([root, item2]) => newest(item2) > (answered.get(root) ?? 0)).sort((a, b) => newest(a[1]) - newest(b[1])).slice(-8);
    if (unread.length === 0) {
      this.scope = setItems(this.scope.channel, [], null);
      this.paintScope();
      this.reply("Inbox is clear.");
      return;
    }
    const channels = this.channels();
    const names = await relay.profiles([...new Set(unread.flatMap(([, item2]) => item2.events.map((e) => e.pubkey)))]);
    const channelName = (id) => channels.find((c) => c.id === id)?.name ?? "a channel";
    const blocks = unread.map(([, item2], index) => {
      const lines = item2.events.slice(-4).map((event) => {
        const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
        const when = new Date(event.created_at * 1e3).toLocaleString();
        return `  ${who} (${when}): ${event.content.replace(/\s+/g, " ").slice(0, 600)}`;
      });
      return [`Unread ${index + 1}, in ${channelName(item2.channelId)}:`, ...lines].join("\n");
    });
    const described = unread.map(([root, item2]) => {
      const last = item2.events[item2.events.length - 1];
      return {
        rootId: root,
        channelId: item2.channelId,
        channelName: channelName(item2.channelId),
        label: last.content.replace(/\s+/g, " ").trim().slice(0, 70) || root.slice(0, 8),
        who: [...new Set(item2.events.map((e) => names.get(e.pubkey) ?? e.pubkey.slice(0, 8)))],
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
          label: body.replace(/\s+/g, " ").slice(0, 70),
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
function scopeOf(connection) {
  const scope = connection.scope ?? "";
  const at = scope.lastIndexOf(":");
  if (at < 0 || scope.slice(at + 1) !== connection.viewer) return void 0;
  return { communityOrigin: scope.slice(0, at), viewer: connection.viewer };
}
function ago(seconds) {
  const delta = Math.max(0, Math.floor(Date.now() / 1e3) - seconds);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}
var row = { display: "flex", gap: "var(--space-2, 8px)", alignItems: "center", flexWrap: "wrap" };
var muted = { opacity: 0.7, fontSize: "0.9em" };
var card = { padding: "var(--space-panel-inset, 16px)", marginBottom: "var(--space-4, 16px)" };
var item = { padding: "var(--space-2, 8px) 0", borderTop: "1px solid var(--color-border, rgba(127,127,127,0.25))" };
var bad = { color: "var(--color-danger, #c0392b)" };
function createUi(deps) {
  const { React, controller, relayService, navigation } = deps;
  const h = React.createElement;
  const { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } = React;
  const useVoice = () => useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const useConnection = () => useSyncExternalStore(relayService.subscribe, relayService.snapshot, relayService.snapshot);
  function openTarget(channelId, messageId, rootId) {
    const scope = scopeOf(relayService.snapshot());
    if (!scope) return;
    void navigation.open({ version: 1, kind: "conversation", scope, channelId, messageId, threadRootId: rootId });
  }
  function Setup({ voice }) {
    if (voice.ready) return null;
    const engine = voice.engine;
    return h(
      "section",
      { className: "ui-card", style: card },
      h("h2", null, "Set up speech"),
      h(
        "p",
        null,
        "Speech is transcribed on this Mac with the same sherpa-onnx whisper model Buzz Voice uses. Nothing is sent anywhere."
      ),
      engine && h(
        "p",
        { style: muted },
        `Engine: ${engine.engine ? "installed" : "missing"}. Model (${voice.settings.whisper}): ${engine.model ? "installed" : "missing"}. Folder: ${voice.settings.modelDir}`
      ),
      voice.engineError && h("p", { role: "alert", style: bad }, voice.engineError),
      h(
        "div",
        { style: row },
        h(
          "button",
          {
            type: "button",
            className: "ui-button ui-button-primary",
            disabled: !!voice.installing,
            onClick: () => void controller.install()
          },
          voice.installing ? `${voice.installing}...` : "Install speech engine"
        ),
        h("button", { type: "button", className: "ui-button", onClick: () => void controller.refreshEngine() }, "Check again")
      )
    );
  }
  function TalkButton({ voice }) {
    const pressedAt = useRef(0);
    const label = voice.transcribing ? "Transcribing..." : voice.listening ? voice.latched ? "Recording. Tap to stop" : "Listening. Release to send" : "Tap or hold to talk";
    const down = (event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (voice.listening && voice.latched) {
        void controller.stopListening();
        return;
      }
      pressedAt.current = Date.now();
      void controller.startListening();
    };
    const up = () => {
      if (!controller.snapshot().listening || controller.snapshot().latched) return;
      if (Date.now() - pressedAt.current < TAP_MS) controller.latch();
      else void controller.stopListening();
    };
    const level = Math.min(1, voice.level * 3);
    return h(
      "div",
      { style: { ...row, marginBottom: "var(--space-3, 12px)" } },
      h(
        "button",
        {
          type: "button",
          className: voice.listening ? "ui-button ui-button-primary" : "ui-button",
          disabled: !voice.ready || voice.transcribing,
          onPointerDown: down,
          onPointerUp: up,
          onPointerCancel: up,
          style: { minWidth: 220, minHeight: 56, fontSize: "1.05em" },
          "aria-pressed": voice.listening
        },
        `\u{1F399} ${label}`
      ),
      h(
        "span",
        {
          "aria-hidden": true,
          style: {
            display: "inline-block",
            width: 120,
            height: 8,
            borderRadius: 4,
            background: "var(--color-border, rgba(127,127,127,0.25))",
            overflow: "hidden"
          }
        },
        h("span", {
          style: {
            display: "block",
            height: "100%",
            width: `${Math.round(level * 100)}%`,
            background: "var(--color-accent, #2e86de)",
            transition: "width 60ms linear"
          }
        })
      ),
      h("span", { style: muted }, "Shortcut: Cmd+Shift+Space")
    );
  }
  function PendingCard({ voice }) {
    const pending = voice.pending;
    const ref = useRef(null);
    useEffect(() => {
      ref.current?.focus();
    }, [pending?.channel.id, pending?.replyTo]);
    if (!pending) return null;
    const found = mentionsIn(pending.body, pending.members);
    const note = found.length ? `Notifies ${found.map((m) => m.name).join(", ")}` : pending.body.includes("@") ? "Nobody in this channel matches that name. Nobody will be notified." : "Nobody will be notified.";
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return h(
      "div",
      { className: "ui-card", style: { ...card, border: "1px solid var(--color-accent, #2e86de)" } },
      h("strong", null, pending.label ? `#${pending.channel.name} \xB7 in "${pending.label}"` : `#${pending.channel.name}`),
      h("textarea", {
        ref,
        "aria-label": "Message to send",
        value: pending.body,
        rows: Math.min(8, Math.max(2, Math.ceil(pending.body.length / 70))),
        spellCheck: false,
        style: { display: "block", width: "100%", margin: "var(--space-2, 8px) 0" },
        onChange: (event) => controller.editPending(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void controller.publish();
          }
          if (event.key === "Escape") controller.cancel();
        }
      }),
      h("p", { style: found.length === 0 && pending.body.includes("@") ? bad : muted }, note),
      found.length === 0 && h(
        "div",
        { style: row },
        pending.members.slice(0, 8).map(
          (member) => h(
            "button",
            {
              key: member.pubkey,
              type: "button",
              className: "ui-button",
              onClick: () => {
                const stripped = pending.addressed ? pending.body.replace(new RegExp(`^\\s*@${escape(pending.addressed)}\\s*`, "i"), "") : pending.body;
                controller.editPending(`@${member.name} ${stripped.trim()}`);
              }
            },
            `@${member.name}`
          )
        )
      ),
      pending.orphaned && h("p", { style: bad }, `No thread open in ${pending.channel.name}. This posts as a new message.`),
      h(
        "div",
        { style: { ...row, marginTop: "var(--space-2, 8px)" } },
        h("button", { type: "button", className: "ui-button ui-button-primary", onClick: () => void controller.publish() }, "Send"),
        h("button", { type: "button", className: "ui-button", onClick: () => controller.cancel() }, "Cancel"),
        h("span", { style: muted }, "Enter sends. Or say yes.")
      )
    );
  }
  function LogRow({ entry }) {
    return h(
      "li",
      { style: item },
      h(
        "div",
        { style: row },
        h("strong", null, entry.role === "you" ? "You" : "Buzz"),
        entry.meta && h("span", { style: muted }, entry.meta),
        entry.link && h(
          "button",
          {
            type: "button",
            className: "ui-button",
            onClick: () => openTarget(entry.link.channelId, entry.link.messageId, entry.link.rootId)
          },
          "Open"
        )
      ),
      h("p", { style: { margin: "4px 0", whiteSpace: "pre-wrap", ...entry.bad ? bad : {} } }, entry.text)
    );
  }
  function Talk({ voice }) {
    const [typed, setTyped] = useState("");
    const end = useRef(null);
    useEffect(() => {
      end.current?.scrollIntoView?.({ block: "nearest" });
    }, [voice.log.length, !!voice.pending]);
    return h(
      React.Fragment,
      null,
      h(Setup, { voice }),
      h(TalkButton, { voice }),
      voice.status && h("p", { role: voice.statusBad ? "alert" : "status", style: voice.statusBad ? bad : muted }, voice.status),
      voice.scope && h("p", { style: muted }, `In scope: ${voice.scope}`),
      voice.watches.length > 0 && h(
        "div",
        { style: { ...row, ...muted } },
        "Watching:",
        voice.watches.map(
          (watch) => h(
            "button",
            {
              key: watch.rootId,
              type: "button",
              className: "ui-button",
              title: "Stop watching",
              onClick: () => controller.unwatch(watch.rootId)
            },
            `${watch.channelName}: ${watch.label.slice(0, 40)} \u2715`
          )
        )
      ),
      h(
        "ol",
        { style: { listStyle: "none", padding: 0, margin: "var(--space-2, 8px) 0" }, "aria-live": "polite" },
        voice.log.length === 0 && h(
          "li",
          { style: muted },
          'Try: "in ops tell build-bot the deploy is done", "how is work going in ops", or "what is in my inbox".'
        ),
        voice.log.map((entry) => h(LogRow, { key: entry.id, entry }))
      ),
      h(PendingCard, { voice }),
      h("div", { ref: end }),
      h(
        "form",
        {
          style: row,
          onSubmit: (event) => {
            event.preventDefault();
            controller.submitText(typed);
            setTyped("");
          }
        },
        h("input", {
          type: "text",
          "aria-label": "Type a command",
          placeholder: "Or type what you would say",
          value: typed,
          disabled: voice.busy,
          style: { flex: "1 1 240px" },
          onChange: (event) => setTyped(event.target.value)
        }),
        h("button", { type: "submit", className: "ui-button", disabled: voice.busy || !typed.trim() }, "Go"),
        h("button", { type: "button", className: "ui-button", onClick: () => controller.stopSpeaking() }, "Stop speaking"),
        h("button", { type: "button", className: "ui-button", onClick: () => controller.newSession() }, "New session")
      )
    );
  }
  function Flags({ relay }) {
    const voice = useVoice();
    const [source, setSource] = useState(emptyFlagSource());
    const [status, setStatus] = useState("Reading reactions...");
    const [mineOnly, setMineOnly] = useState(false);
    const [emoji, setEmoji] = useState(null);
    const load = useCallback(() => {
      setStatus((current) => current || "Refreshing...");
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
    const flags = useMemo(
      () => groupFlags(source, channelNames, { mineOnly, emoji }),
      [source, channelNames, mineOnly, emoji]
    );
    const chip = (label, pressed, onPick, key) => h(
      "button",
      {
        key,
        type: "button",
        className: pressed ? "ui-button ui-button-primary" : "ui-button",
        "aria-pressed": pressed,
        onClick: onPick
      },
      label
    );
    return h(
      React.Fragment,
      null,
      h(
        "div",
        { style: { ...row, marginBottom: "var(--space-2, 8px)" } },
        chip("Everyone", !mineOnly, () => setMineOnly(false), "everyone"),
        chip("Mine", mineOnly, () => setMineOnly(true), "mine"),
        h("button", { type: "button", className: "ui-button", onClick: load }, "Refresh")
      ),
      h(
        "div",
        { role: "radiogroup", "aria-label": "Emoji", style: { ...row, marginBottom: "var(--space-3, 12px)" } },
        chip(`All (${new Set(groupFlags(source, channelNames, { mineOnly, emoji: null }).map((f) => f.rootId)).size})`, emoji === null, () => setEmoji(null), "all"),
        counts.map(([e, count]) => chip(`${e} ${count}`, emoji === e, () => setEmoji(emoji === e ? null : e), e))
      ),
      status && h("p", { style: muted }, status),
      !status && flags.length === 0 && h("p", { style: muted }, "No flagged threads."),
      h(
        "ul",
        { style: { listStyle: "none", padding: 0, margin: 0 } },
        flags.map(
          (flag) => h(
            "li",
            { key: flag.rootId, style: item },
            h(
              "div",
              { style: row },
              h("span", { style: { fontSize: "1.2em" } }, flag.emoji.join(" ")),
              h("strong", null, `#${flag.channelName}`),
              h("span", { style: muted }, `${flag.who.join(", ")} \xB7 ${ago(flag.at)}`)
            ),
            h("p", { style: { margin: "4px 0" } }, flag.title),
            flag.excerpt && h("p", { style: { ...muted, margin: "0 0 4px" } }, `\u21B3 ${flag.excerpt}`),
            h(
              "div",
              { style: row },
              h(
                "button",
                { type: "button", className: "ui-button", onClick: () => openTarget(flag.channelId, flag.messageId, flag.rootId) },
                "Open in Buzz"
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "ui-button",
                  onClick: () => voice.watches.some((w) => w.rootId === flag.rootId) ? controller.unwatch(flag.rootId) : controller.watch({
                    rootId: flag.rootId,
                    channelId: flag.channelId,
                    channelName: flag.channelName,
                    label: flag.title,
                    since: Math.floor(Date.now() / 1e3)
                  })
                },
                voice.watches.some((w) => w.rootId === flag.rootId) ? "Following" : "Follow"
              )
            )
          )
        )
      )
    );
  }
  function Page() {
    const connection = useConnection();
    const voice = useVoice();
    const [tab, setTab] = useState("talk");
    const relay = useMemo(() => connection.status === "ready" ? deps.relay() : null, [connection.scope, connection.generation, connection.status]);
    useEffect(() => {
      if (connection.status === "ready") connection.session?.channels?.ensureList?.();
    }, [connection.session]);
    const tabButton = (id, label) => h(
      "button",
      {
        type: "button",
        role: "tab",
        "aria-selected": tab === id,
        className: tab === id ? "ui-button ui-button-primary" : "ui-button",
        onClick: () => setTab(id)
      },
      label
    );
    return h(
      "div",
      { style: { padding: "var(--space-panel-inset, 16px)", maxWidth: 900, height: "100%", overflowY: "auto" } },
      h("h1", null, "Buzz Voice"),
      h("div", { role: "tablist", style: { ...row, marginBottom: "var(--space-3, 12px)" } }, tabButton("talk", "Talk"), tabButton("flags", "Flags")),
      connection.status !== "ready" || !relay ? h(
        "p",
        { role: connection.status === "error" ? "alert" : "status" },
        connection.status === "error" ? connection.error ?? "Could not connect." : "Connecting to the community..."
      ) : tab === "talk" ? h(Talk, { voice }) : h(Flags, { key: `${connection.scope}:${connection.generation}`, relay })
    );
  }
  function SettingsCard() {
    const voice = useVoice();
    const s = voice.settings;
    const field = (label, key, extra = {}) => h(
      "label",
      { style: { display: "block", marginBottom: "var(--space-2, 8px)" } },
      h("div", null, label),
      h("input", {
        type: "text",
        value: String(s[key] ?? ""),
        style: { width: "100%" },
        onChange: (event) => controller.updateSettings({ [key]: event.target.value }),
        ...extra
      })
    );
    return h(
      "div",
      null,
      h("h3", null, "Speech to text"),
      h(
        "p",
        { style: muted },
        voice.engine ? `Engine ${voice.engine.engine ? "installed" : "missing"}, model ${voice.engine.model ? "installed" : "missing"}.` : voice.engineError || "Not checked yet."
      ),
      field("Model folder", "modelDir"),
      field("Whisper model (small.en, base.en, tiny.en)", "whisper"),
      h(
        "div",
        { style: row },
        h(
          "button",
          { type: "button", className: "ui-button ui-button-primary", disabled: !!voice.installing, onClick: () => void controller.install() },
          voice.installing ? `${voice.installing}...` : "Install or repair"
        ),
        h("button", { type: "button", className: "ui-button", onClick: () => void controller.refreshEngine() }, "Check")
      ),
      h("h3", null, "Language model"),
      h(
        "p",
        { style: muted },
        "Writes the message body and reads channels back. Any OpenAI-compatible endpoint, http or https, called from this Mac. Routing uses the Decisions API provider chosen in Settings when one is on. Filled from the Buzz Voice app when it is installed."
      ),
      field("Base URL (for example http://host:4000/v1)", "llmUrl"),
      field("Model", "llmModel"),
      field("API key (optional)", "llmKey", { type: "password", autoComplete: "off" }),
      h("h3", null, "Spoken replies"),
      h(
        "label",
        { style: { display: "block", marginBottom: "var(--space-2, 8px)" } },
        h("input", {
          type: "checkbox",
          checked: s.speak,
          onChange: (event) => controller.updateSettings({ speak: event.target.checked })
        }),
        " Read replies out loud"
      ),
      field("macOS voice (blank for the system voice)", "voice")
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
