import {
  checkEngine,
  installEngine,
  llmPoster,
  loadJson,
  loadSettings,
  Recorder,
  saveJson,
  saveSettings,
  Speaker,
  transcribe,
  type EngineStatus,
  type Host,
  type Settings,
} from "./engine";
import {
  parseIntent,
  pickThread,
  summarizeChannel,
  summarizeInbox,
  type Intent,
  type LlmConfig,
} from "./intent";
import { bestPerson, matchChannel } from "./match";
import type { Relay } from "./relay";
import {
  describeThread,
  emptyScope,
  rememberPost,
  resolveThread,
  scopeLabel,
  setItems,
  setThreads,
  threadByRef,
  type Scope,
  type ScopeThread,
} from "./scope";
import { rootOf, tagValue, type Channel, type Decide, type Event, type Member, type Thread, type ThreadState, type Turn } from "./types";

export interface LogEntry {
  id: number;
  role: "you" | "app";
  text: string;
  bad?: boolean;
  meta?: string;
  link?: { channelId: string; messageId: string; rootId: string };
}

export interface Pending {
  channel: Channel;
  replyTo: string | null;
  label: string | null;
  orphaned: boolean;
  body: string;
  addressed: string | null;
  members: Member[];
}

export interface Watch {
  rootId: string;
  channelId: string;
  channelName: string;
  label: string;
  since: number;
  until: number;
}

interface Tracked {
  rootId: string;
  channelId: string;
  channelName: string;
  instruction: string;
  createdAt: number;
  state: ThreadState;
  lastReply?: string;
}

export interface VoiceState {
  ready: boolean;
  listening: boolean;
  latched: boolean;
  transcribing: boolean;
  busy: boolean;
  level: number;
  status: string;
  statusBad: boolean;
  log: LogEntry[];
  pending: Pending | null;
  scope: string;
  watches: Watch[];
  engine: EngineStatus | null;
  engineError: string;
  installing: string;
  settings: Settings;
  routing: string;
}

const HISTORY_TURNS = 12;
const INBOX_DAYS = 3;
const WATCH_HOURS = 8;
const MAX_WATCHES = 12;
const POLL_MS = 15_000;
const MAX_LOG = 200;
const WATCH_KEY = "buzz-voice-plugin.watches";
const TRACK_KEY = "buzz-voice-plugin.threads";

const STATE_EMOJI: Record<Exclude<ThreadState, "unknown">, string> = {
  working: "\u{1F504}",
  stalled: "\u{26D4}",
  done: "✅",
  "needs-input": "\u{1F440}",
};
const EMOJI_STATE = new Map<string, ThreadState>(
  Object.entries(STATE_EMOJI).map(([state, emoji]) => [emoji, state as ThreadState]),
);

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionsIn(body: string, members: Member[]): Member[] {
  return members.filter((member) => new RegExp(`@${escapeRe(member.name)}(?![\\w-])`, "i").test(body));
}

function block(thread: Thread, index: number, names: Map<string, string>): string {
  const lines = thread.messages.slice(-12).map((event) => {
    const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
    const when = new Date(event.created_at * 1000).toLocaleString();
    return `  ${who} (${when}): ${event.content.replace(/\s+/g, " ").slice(0, 600)}`;
  });
  return [`Thread ${index + 1}:`, ...lines].join("\n");
}

function spoken(who: string, channelName: string, content: string): string {
  const body = content
    .replace(/```[\s\S]*?```/g, " a code block ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " a link ")
    .replace(/nostr:\S+/g, " ")
    .replace(/^@\S+\s*/, "")
    .replace(/[*_~`#>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = body.length > 420 ? `${body.slice(0, 420).replace(/\s\S*$/, "")}...` : body;
  return `${who} in ${channelName}. ${cut}`;
}

export interface ControllerDeps {
  host: Host;
  relay: () => Relay | null;
  decide: () => Decide | null;
  community: () => string | undefined;
}

export class Controller {
  private state: VoiceState;
  private listeners = new Set<() => void>();
  private recorder = new Recorder();
  private speaker: Speaker;
  private scope: Scope = emptyScope();
  private history: Turn[] = [];
  private turn = 0;
  private nextId = 1;
  private awaitingYesNo = false;
  private tracked: Tracked[] = loadJson<Tracked[]>(TRACK_KEY, []);
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private levelFrame = 0;

  constructor(private readonly deps: ControllerDeps) {
    this.speaker = new Speaker(deps.host, () => this.state.settings);
    const watches = loadJson<Watch[]>(WATCH_KEY, []).filter((w) => w.until > now());
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
      routing: "",
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): VoiceState => this.state;

  private set(patch: Partial<VoiceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  start(): () => void {
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    void this.refreshEngine();
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.recorder.cancel();
      this.speaker.stop();
    };
  }

  private llm(): LlmConfig | null {
    const settings = this.state.settings;
    if (!settings.llmUrl) return null;
    return { model: settings.llmModel || "default", post: llmPoster(this.deps.host, settings) };
  }

  updateSettings(patch: Partial<Settings>): void {
    const settings = { ...this.state.settings, ...patch };
    saveSettings(settings);
    this.set({ settings });
  }

  async refreshEngine(): Promise<void> {
    try {
      const engine = await checkEngine(this.deps.host, this.state.settings);
      this.set({ engine, engineError: "", ready: engine.engine && engine.model });
      this.adoptBuzzVoice(engine);
    } catch (error) {
      this.set({ engine: null, engineError: message(error), ready: false });
    }
  }

  private adoptBuzzVoice(engine: EngineStatus): void {
    const saved = engine.buzzVoice;
    const settings = this.state.settings;
    if (!saved || settings.llmUrl) return;
    const url = typeof saved.llm_url === "string" ? saved.llm_url : "";
    const model = typeof saved.llm_model === "string" ? saved.llm_model : "";
    if (url) this.updateSettings({ llmUrl: url, llmModel: settings.llmModel || model });
  }

  async install(): Promise<void> {
    this.set({ installing: "Starting", engineError: "" });
    try {
      const engine = await installEngine(this.deps.host, this.state.settings, (step) =>
        this.set({ installing: step === "engine" ? "Downloading the speech engine" : "Downloading the whisper model" }),
      );
      this.set({ engine, installing: "", ready: engine.engine && engine.model });
    } catch (error) {
      this.set({ installing: "", engineError: message(error) });
    }
  }

  private setStatus(status: string, bad = false): void {
    this.set({ status, statusBad: bad });
  }

  private say(role: "you" | "app", text: string, extra: Partial<LogEntry> = {}): void {
    const entry: LogEntry = { id: this.nextId++, role, text, ...extra };
    this.set({ log: [...this.state.log, entry].slice(-MAX_LOG) });
    this.history.push({ role, text });
    if (this.history.length > HISTORY_TURNS) this.history.splice(0, this.history.length - HISTORY_TURNS);
  }

  private reply(text: string, opts: { bad?: boolean } = {}): void {
    this.say("app", text, { bad: opts.bad });
    this.setStatus(opts.bad ? text : "", opts.bad);
    this.speaker.speak(text);
  }

  newSession(): void {
    this.turn += 1;
    this.scope = emptyScope();
    this.history = [];
    this.awaitingYesNo = false;
    this.set({ log: [], pending: null, scope: "", busy: false, status: "" });
  }

  stopSpeaking(): void {
    this.speaker.stop();
  }

  async startListening(): Promise<void> {
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
      this.set({ listening: true, latched: false, status: "Listening..." , statusBad: false });
    } catch (error) {
      this.setStatus(`Microphone: ${message(error)}`, true);
    }
  }

  latch(): void {
    if (this.state.listening) this.set({ latched: true });
  }

  async toggleListening(): Promise<void> {
    if (this.state.listening) return this.stopListening();
    await this.startListening();
    this.latch();
  }

  async stopListening(): Promise<void> {
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

  cancelListening(): void {
    this.recorder.cancel();
    this.set({ listening: false, latched: false, level: 0, status: "" });
  }

  submitText(text: string): void {
    const trimmed = text.trim();
    if (trimmed) void this.handleTranscript(trimmed);
  }

  private channels(): Channel[] {
    return this.deps.relay()?.channels() ?? [];
  }

  private async people(relay: Relay, channels: Channel[]): Promise<string[]> {
    const ids = new Set<string>();
    for (const channel of channels) for (const id of channel.members ?? []) if (id !== relay.pubkey) ids.add(id);
    const names = await relay.profiles([...ids].slice(0, 400));
    return [...new Set(names.values())].filter(Boolean).sort();
  }

  async handleTranscript(text: string): Promise<void> {
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

  private async route(relay: Relay, text: string): Promise<void> {
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
        turns: this.history.slice(0, -1),
      });
      if (!live()) return;

      if (intent.action === "inbox") return await this.readInbox(relay, text);

      const named = matchChannel(channels, intent.channel, text);
      const referenced = threadByRef(this.scope, intent.thread_ref);
      const byRef = referenced ? (channels.find((c) => c.id === referenced.channelId) ?? null) : null;
      const staying = intent.continues_previous || intent.thread === "existing";
      const channel = named ?? byRef ?? (staying ? this.scope.channel : null);

      if (intent.action === "status") {
        if (channel) {
          const target =
            named && named.id !== this.scope.channel?.id ? null : resolveThread(this.scope, channel, intent.thread_ref);
          if (target && (intent.thread === "existing" || intent.thread_ref !== null)) {
            return await this.readThread(relay, channel, target, text);
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
          { bad: true },
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
      const target = intent.new_thread
        ? null
        : (resolveThread(this.scope, channel, intent.thread_ref) ?? (await this.findThread(relay, channel, intent, text)));
      if (!live()) return;

      this.set({
        pending: {
          channel,
          replyTo: target?.rootId ?? null,
          label: target?.label ?? null,
          orphaned: !intent.new_thread && !target,
          body,
          addressed,
          members,
        },
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

  private async findThread(relay: Relay, channel: Channel, intent: Intent, transcript: string): Promise<ScopeThread | null> {
    this.setStatus(`Finding the thread in ${channel.name}...`);
    const all = await relay.threads(channel.id);
    if (all.length === 0) return null;
    const recent = all.slice(-12);
    const names = await relay.profiles([...new Set(recent.flatMap((t) => t.messages.map((m) => m.pubkey)))]);
    const owned = recent
      .map((thread) => describeThread(thread, names))
      .map((t) => ({ ...t, channelId: channel.id, channelName: channel.name }));
    const newest = owned[owned.length - 1];
    if (!intent.thread_hint) return newest;
    const ref = await pickThread({
      llm: this.llm(),
      decide: this.deps.decide(),
      community: this.deps.community(),
      channelName: channel.name,
      hint: intent.thread_hint,
      transcript,
      labels: owned.map((t) => t.label),
    }).catch(() => null);
    return ref === null ? newest : owned[ref - 1];
  }

  private requireLlm(): LlmConfig {
    const llm = this.llm();
    if (!llm) throw new Error("Reading back needs an LLM. Add one in Buzz Voice settings.");
    return llm;
  }

  private paintScope(): void {
    this.set({ scope: scopeLabel(this.scope) });
  }

  private async readChannel(relay: Relay, channel: Channel, question: string): Promise<void> {
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
    const picked = answer.thread ? (described[answer.thread - 1] ?? null) : null;
    this.scope = setThreads(this.scope, channel, described, picked);
    this.paintScope();
    this.reply(answer.answer);
  }

  private async readThread(relay: Relay, channel: Channel, thread: ScopeThread, question: string): Promise<void> {
    this.setStatus(`Reading that thread in ${channel.name}...`);
    const [root, replies] = await Promise.all([
      relay.byIds([thread.rootId]),
      relay.messagesInThread(channel.id, thread.rootId),
    ]);
    const messages = [...root, ...replies]
      .filter((event, index, list) => list.findIndex((e) => e.id === event.id) === index)
      .sort((a, b) => a.created_at - b.created_at);
    if (messages.length === 0) return this.readChannel(relay, channel, question);
    const names = await relay.profiles([...new Set(messages.map((m) => m.pubkey))]);
    const one: Thread = {
      rootId: thread.rootId,
      messages: messages.slice(-24),
      lastAt: messages[messages.length - 1].created_at,
    };
    const answer = await summarizeChannel(this.requireLlm(), channel.name, question, [block(one, 0, names)]);
    this.scope = { ...this.scope, channel, focus: thread };
    this.paintScope();
    this.watch({ rootId: thread.rootId, channelId: channel.id, channelName: channel.name, label: thread.label, since: one.lastAt });
    this.reply(answer.answer);
  }

  private async readInbox(relay: Relay, question: string): Promise<void> {
    this.setStatus("Checking your inbox...");
    const since = now() - INBOX_DAYS * 86400;
    const mentions = await relay.mentions(since);
    const byRoot = new Map<string, { channelId: string; events: Event[] }>();
    for (const event of mentions) {
      const channelId = tagValue(event, "h");
      if (!channelId) continue;
      const root = rootOf(event);
      const bucket = byRoot.get(root);
      if (bucket) bucket.events.push(event);
      else byRoot.set(root, { channelId, events: [event] });
    }
    const answered = new Map<string, number>();
    for (const event of await relay.mineIn([...byRoot.keys()])) {
      const root = rootOf(event);
      answered.set(root, Math.max(answered.get(root) ?? 0, event.created_at));
    }
    const newest = (item: { events: Event[] }) => item.events[item.events.length - 1].created_at;
    const unread = [...byRoot.entries()]
      .filter(([root, item]) => newest(item) > (answered.get(root) ?? 0))
      .sort((a, b) => newest(a[1]) - newest(b[1]))
      .slice(-8);
    if (unread.length === 0) {
      this.scope = setItems(this.scope.channel, [], null);
      this.paintScope();
      this.reply("Inbox is clear.");
      return;
    }
    const channels = this.channels();
    const names = await relay.profiles([...new Set(unread.flatMap(([, item]) => item.events.map((e) => e.pubkey)))]);
    const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? "a channel";
    const blocks = unread.map(([, item], index) => {
      const lines = item.events.slice(-4).map((event) => {
        const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
        const when = new Date(event.created_at * 1000).toLocaleString();
        return `  ${who} (${when}): ${event.content.replace(/\s+/g, " ").slice(0, 600)}`;
      });
      return [`Unread ${index + 1}, in ${channelName(item.channelId)}:`, ...lines].join("\n");
    });
    const described: ScopeThread[] = unread.map(([root, item]) => {
      const last = item.events[item.events.length - 1];
      return {
        rootId: root,
        channelId: item.channelId,
        channelName: channelName(item.channelId),
        label: last.content.replace(/\s+/g, " ").trim().slice(0, 70) || root.slice(0, 8),
        who: [...new Set(item.events.map((e) => names.get(e.pubkey) ?? e.pubkey.slice(0, 8)))],
        lastAt: last.created_at,
      };
    });
    const answer = await summarizeInbox(this.requireLlm(), question, blocks);
    const picked =
      (answer.thread ? (described[answer.thread - 1] ?? null) : null) ?? (described.length === 1 ? described[0] : null);
    const home = picked ? (channels.find((c) => c.id === picked.channelId) ?? null) : null;
    this.scope = setItems(home ?? this.scope.channel, described, picked);
    this.paintScope();
    this.reply(answer.answer);
  }

  editPending(body: string): void {
    if (this.state.pending) this.set({ pending: { ...this.state.pending, body } });
  }

  cancel(): void {
    this.awaitingYesNo = false;
    if (this.state.pending) this.say("app", "Cancelled.");
    this.set({ pending: null, status: "" });
  }

  async publish(): Promise<void> {
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
        replyTo: replyTo ?? undefined,
      });
      const rootId = replyTo ?? event.id;
      this.track({
        rootId,
        channelId: channel.id,
        channelName: channel.name,
        instruction: body.slice(0, 160),
        createdAt: event.created_at,
        state: "unknown",
      });
      const existing = replyTo ? this.scope.threads.find((t) => t.rootId === replyTo) : undefined;
      this.scope = rememberPost(
        this.scope,
        channel,
        existing ?? {
          rootId,
          channelId: channel.id,
          channelName: channel.name,
          label: body.replace(/\s+/g, " ").slice(0, 70),
          who: mentioned.length ? [mentioned[0].name] : [],
          lastAt: event.created_at,
        },
      );
      this.paintScope();
      this.watch({ rootId, channelId: channel.id, channelName: channel.name, label: body, since: event.created_at });
      this.say("app", body, {
        meta: `Posted to ${channel.name}${replyTo ? ", in thread" : ""}`,
        link: { channelId: channel.id, messageId: event.id, rootId },
      });
      this.setStatus(`Posted to ${channel.name}. Watching for a reply.`);
      this.speaker.speak("Posted.");
    } catch (error) {
      this.reply(`That did not send: ${message(error)}`, { bad: true });
    }
  }

  watch(input: Omit<Watch, "until">): void {
    const watch: Watch = { ...input, label: input.label.replace(/\s+/g, " ").slice(0, 90), until: now() + WATCH_HOURS * 3600 };
    const rest = this.state.watches.filter((w) => w.rootId !== watch.rootId);
    const watches = [watch, ...rest].slice(0, MAX_WATCHES);
    saveJson(WATCH_KEY, watches);
    this.set({ watches });
  }

  unwatch(rootId: string): void {
    const watches = this.state.watches.filter((w) => w.rootId !== rootId);
    saveJson(WATCH_KEY, watches);
    this.set({ watches });
  }

  isWatching(rootId: string): boolean {
    return this.state.watches.some((w) => w.rootId === rootId);
  }

  private async tick(): Promise<void> {
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
      const fresh: { watch: Watch; event: Event }[] = [];
      for (const event of events) {
        if (event.pubkey === relay.pubkey) continue;
        const watch = byRoot.get(rootOf(event)) ?? byRoot.get(event.id);
        if (!watch || event.created_at <= watch.since) continue;
        fresh.push({ watch, event });
      }
      if (fresh.length === 0) return;
      const names = await relay.profiles([...new Set(fresh.map((f) => f.event.pubkey))]);
      const seen = new Map<string, number>();
      for (const { watch, event } of fresh) {
        seen.set(watch.rootId, Math.max(seen.get(watch.rootId) ?? 0, event.created_at));
      }
      const watches = this.state.watches.map((w) => (seen.has(w.rootId) ? { ...w, since: seen.get(w.rootId) as number } : w));
      saveJson(WATCH_KEY, watches);
      this.set({ watches });
      for (const { watch, event } of fresh.sort((a, b) => a.event.created_at - b.event.created_at)) {
        const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
        this.say("app", event.content, {
          meta: `${who} in ${watch.channelName}`,
          link: { channelId: watch.channelId, messageId: event.id, rootId: watch.rootId },
        });
        this.tracked = this.tracked.map((t) =>
          t.rootId === watch.rootId ? { ...t, lastReply: event.content.replace(/\s+/g, " ").slice(0, 240) } : t,
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

  private track(thread: Tracked): void {
    this.tracked = [thread, ...this.tracked.filter((t) => t.rootId !== thread.rootId)].slice(0, 100);
    saveJson(TRACK_KEY, this.tracked);
  }

  private async refreshTracked(relay: Relay): Promise<void> {
    if (this.tracked.length === 0) return;
    const roots = this.tracked.map((t) => t.rootId);
    const reactions = await relay.query([{ kinds: [7], "#e": roots, limit: 500 }]).catch(() => [] as Event[]);
    const latest = new Map<string, Event>();
    for (const reaction of reactions) {
      const root = reaction.tags.filter((t) => t[0] === "e").at(-1)?.[1];
      if (!root) continue;
      const key = `${root}:${reaction.pubkey}`;
      const seen = latest.get(key);
      if (!seen || seen.created_at < reaction.created_at) latest.set(key, reaction);
    }
    const byRoot = new Map<string, Event>();
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

  private summarizeTracked(filter: ThreadState | "all"): string {
    const matching = filter === "all" ? this.tracked : this.tracked.filter((t) => t.state === filter);
    if (matching.length === 0) {
      return filter === "all" ? "Nothing is tracked yet." : `Nothing is ${filter.replace("-", " ")}.`;
    }
    const lines = matching
      .slice(0, 6)
      .map((t) => `${t.channelName}: ${t.instruction}${t.lastReply ? `. Last update: ${t.lastReply}` : ""}`);
    const heading =
      filter === "all"
        ? `${matching.length} tracked ${matching.length === 1 ? "thread" : "threads"}.`
        : `${matching.length} ${filter.replace("-", " ")}.`;
    return [heading, ...lines].join(" ");
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
