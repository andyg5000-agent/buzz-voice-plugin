import { runAgentTurn, type AgentContextSnapshot, type AgentMessage } from "./agent";
import {
  checkEngine,
  checkTtsModel,
  installEngine,
  installRuntime,
  installTtsModel,
  llmPoster,
  llmStream,
  loadJson,
  loadSettings,
  Listener,
  Recorder,
  saveJson,
  saveSettings,
  Speaker,
  transcribe,
  pcmBase64,
  type EngineStatus,
  type Heard,
  type Host,
  type Settings,
  listVoices,
  type SystemVoice,
} from "./engine";
import {
  parseIntent,
  pickThread,
  summarizeChannel,
  summarizeInbox,
  type Intent,
  type LlmConfig,
  type TodoOp,
} from "./intent";
import { addTodo, assignTodo, findTodo, readTodos, setStatus, type Status, type Todo } from "./todos";
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
import { SentenceBuffer } from "./stream";
import { plain, rootOf, tagValue, type Channel, type Decide, type Event, type Member, type Thread, type ThreadState, type Turn } from "./types";

export interface LogEntry {
  id: number;
  role: "you" | "app";
  text: string;
  bad?: boolean;
  meta?: string;
  streaming?: boolean;
  link?: { channelId: string; messageId: string; rootId: string };
}

export interface PendingTodo {
  op: Exclude<TodoOp, "list">;
  label: string;
  offset: number | null;
  assignee: Member | null;
}

export interface Pending {
  todo: PendingTodo | null;
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

export type VoiceActivity = "idle" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking";

export interface VoiceState {
  ready: boolean;
  listening: boolean;
  opening: boolean;
  latched: boolean;
  transcribing: boolean;
  busy: boolean;
  speaking: boolean;
  activity: VoiceActivity;
  activityDetail: string;
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
  liveMode: boolean;
  handsFree: boolean;
  hearing: boolean;
  awake: boolean;
  huddlePaused: boolean;
}

const HISTORY_TURNS = 12;
const AGENT_HISTORY_MAX = 24;
const INBOX_DAYS = 3;
const WATCH_HOURS = 8;
const MAX_WATCHES = 12;
const FALLBACK_POLL_MS = 45_000;
const MAX_LOG = 200;
const WATCH_KEY = "buzz-voice-plugin.watches";
const TRACK_KEY = "buzz-voice-plugin.threads";
const FOLLOW_UP_MS = 12_000;
const BARGE_IN_CONFIRM_MS = 180;
const YES = /\b(yes|yep|yeah|send it|do it|go ahead|confirm|sure)\b/i;
const NO = /\b(no|nope|cancel|stop|never ?mind|don'?t)\b/i;
const NOISE = /^\W*(?:thank you|thanks|you|bye|okay|ok|uh|um|hmm|mm|oh|so|yeah)\W*$/i;
const OP_STATUS: Record<"start" | "done" | "reopen", Status> = { start: "doing", done: "done", reopen: "todo" };

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
  private agentHistory: AgentMessage[] = [];
  private turn = 0;
  private activeAbort: AbortController | null = null;
  private nextId = 1;
  private awaitingYesNo = false;
  private tracked: Tracked[] = loadJson<Tracked[]>(TRACK_KEY, []);
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private levelFrame = 0;
  private stopWhenOpen = false;
  private listener: Listener;
  private awakeUntil = 0;
  private wantHandsFree = false;
  private wantLiveMode = false;
  private pausedMode: "live" | "handsFree" | null = null;
  private bargeInTimer: ReturnType<typeof setTimeout> | null = null;

  // Reactive relay caches & live watch observer
  private peopleCache: string[] = [];
  private peopleCacheAt = 0;
  private observedRelay: Relay | null = null;
  private relayUnsubs: (() => void)[] = [];
  private watchObserver: { dispose(): void; refresh(): Promise<void> } | null = null;
  private watchKey = "";
  private seenReplyIds = new Set<string>();

  constructor(private readonly deps: ControllerDeps) {
    this.speaker = new Speaker(deps.host, () => this.state.settings);
    this.speaker.setSharedAudioContext(() => this.recorder.audioContext);
    this.speaker.onStateChange = (speaking) => {
      this.set({ speaking });
      this.syncActivity();
    };
    this.speaker.onError = (err) => {
      this.setStatus(`Speech output: ${err}`, true);
    };
    this.speaker.onIdle = () => {
      this.syncActivity();
      if (this.state.handsFree && !this.state.liveMode) {
        if (!this.state.settings.bargeIn) this.listener.reset();
        this.wake(FOLLOW_UP_MS);
      }
    };

    this.listener = new Listener(deps.host);
    this.listener.onHeard = (heard) => this.heard(heard);
    this.listener.onExit = () => {
      if (this.wantLiveMode) void this.dropLive("Speech recognition stopped. Turn Live on to restart it.");
      else if (this.wantHandsFree) void this.dropHandsFree("Speech recognition stopped. Turn hands-free on to restart it.");
    };
    this.recorder.onLost = () => {
      if (this.wantLiveMode) void this.dropLive("The microphone disconnected.");
      else if (this.wantHandsFree) void this.dropHandsFree("The microphone disconnected.");
    };

    const watches = loadJson<Watch[]>(WATCH_KEY, []).filter((w) => w.until > now());
    this.state = {
      ready: false,
      listening: false,
      opening: false,
      latched: false,
      transcribing: false,
      busy: false,
      speaking: false,
      activity: "idle",
      activityDetail: "",
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
      liveMode: false,
      handsFree: false,
      hearing: false,
      awake: false,
      huddlePaused: false,
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

  private syncActivity(detail?: string): void {
    const s = this.state;
    let activity: VoiceActivity = "idle";
    if (s.listening || s.hearing) activity = s.hearing ? "hearing" : "listening";
    else if (s.transcribing) activity = "transcribing";
    else if (s.speaking) activity = "speaking";
    else if (s.busy) activity = "thinking";
    else if (s.liveMode || s.handsFree) activity = "listening";
    const nextDetail = detail !== undefined ? detail : activity === "thinking" ? s.activityDetail : "";
    if (s.activity !== activity || s.activityDetail !== nextDetail) {
      this.set({ activity, activityDetail: nextDetail });
    }
  }

  start(): () => void {
    this.timer = setInterval(() => {
      this.ensureRelayBindings();
      void this.tick();
    }, FALLBACK_POLL_MS);
    this.ensureRelayBindings();
    void this.refreshEngine().then(() => {
      if (this.state.settings.handsFree) void this.setHandsFree(true);
    });
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.clearBargeInTimer();
      this.abortTurn();
      this.teardownRelayBindings();
      this.recorder.release();
      this.listener.stop();
      this.speaker.dispose();
    };
  }

  /** Called from index.ts whenever Buzz relay connection changes. */
  onRelayChanged(): void {
    this.ensureRelayBindings();
  }

  /** Auto-pauses Live/Hands-free while the user is in a native Buzz Huddle. */
  setHuddleActive(active: boolean): void {
    if (active) {
      if (this.wantLiveMode) {
        this.pausedMode = "live";
        void this.setLiveMode(false);
        this.set({ huddlePaused: true, status: "Paused while in a Huddle." });
      } else if (this.wantHandsFree) {
        this.pausedMode = "handsFree";
        void this.setHandsFree(false, false);
        this.set({ huddlePaused: true, status: "Paused while in a Huddle." });
      }
      return;
    }
    const resume = this.pausedMode;
    this.pausedMode = null;
    if (this.state.huddlePaused) this.set({ huddlePaused: false });
    if (resume === "live") void this.setLiveMode(true);
    else if (resume === "handsFree") void this.setHandsFree(true, false);
  }

  private ensureRelayBindings(): void {
    const relay = this.deps.relay();
    if (relay === this.observedRelay) {
      this.syncWatchObserver();
      return;
    }
    this.teardownRelayBindings();
    this.observedRelay = relay;
    if (!relay) return;

    this.peopleCache = [];
    this.peopleCacheAt = 0;
    const bumpPeople = () => {
      void this.refreshPeopleCache(relay);
    };
    this.relayUnsubs.push(relay.session.channels.subscribeList(bumpPeople));
    this.relayUnsubs.push(relay.session.profiles.subscribe(() => this.rebuildPeopleFromSnapshot(relay)));
    void this.refreshPeopleCache(relay);
    this.syncWatchObserver();
  }

  private teardownRelayBindings(): void {
    for (const off of this.relayUnsubs) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    this.relayUnsubs = [];
    this.disposeWatchObserver();
    this.observedRelay = null;
  }

  private disposeWatchObserver(): void {
    if (this.watchObserver) {
      try {
        this.watchObserver.dispose();
      } catch {
        // ignore
      }
      this.watchObserver = null;
      this.watchKey = "";
    }
  }

  /** Subscribes live to watched threads via `session.observe` for <1s reply reactivity. */
  private syncWatchObserver(): void {
    const relay = this.observedRelay;
    const live = this.state.watches.filter((w) => w.until > now());
    if (!relay || live.length === 0) {
      this.disposeWatchObserver();
      return;
    }
    const roots = live.map((w) => w.rootId).sort();
    const key = roots.join(",");
    if (this.watchObserver && this.watchKey === key) return;

    this.disposeWatchObserver();
    this.watchKey = key;
    const since = Math.min(...live.map((w) => w.since)) + 1;
    try {
      const obs = relay.session.observe([{ kinds: [9], "#e": roots, since, limit: 200 }]);
      const unsub = obs.subscribe(() => {
        const snap = obs.snapshot();
        if (snap.events?.length) void this.ingestReplies(relay, snap.events);
      });
      this.watchObserver = {
        refresh: () => obs.refresh(),
        dispose: () => {
          unsub();
          obs.dispose();
        },
      };
    } catch {
      this.watchObserver = null;
      this.watchKey = "";
    }
  }

  private rebuildPeopleFromSnapshot(relay: Relay): void {
    const channels = relay.channels();
    const ids = new Set<string>();
    for (const channel of channels) for (const id of channel.members ?? []) if (id !== relay.pubkey) ids.add(id);
    const snap = relay.session.profiles.snapshot();
    const names = new Set<string>();
    for (const id of ids) {
      const name = snap.get(id)?.name;
      if (name) names.add(name);
    }
    if (names.size > 0) this.peopleCache = [...names].sort();
  }

  private async refreshPeopleCache(relay: Relay): Promise<void> {
    const channels = relay.channels();
    const ids = new Set<string>();
    for (const channel of channels) for (const id of channel.members ?? []) if (id !== relay.pubkey) ids.add(id);
    if (ids.size === 0) return;
    await relay.session.profiles.ensure([...ids].slice(0, 400)).catch(() => undefined);
    this.rebuildPeopleFromSnapshot(relay);
    this.peopleCacheAt = Date.now();
  }

  private isSttReady(engine: EngineStatus | null, settings: Settings): boolean {
    if (settings.sttBackend === "openai" && settings.sttUrl.trim()) return true;
    return !!(engine?.engine && engine?.model);
  }

  private llm(): LlmConfig | null {
    const settings = this.state.settings;
    if (!settings.llmUrl.trim()) return null;
    return { model: settings.llmModel || "default", post: llmPoster(this.deps.host, settings) };
  }

  updateSettings(patch: Partial<Settings>): void {
    const prev = this.state.settings;
    const settings = { ...prev, ...patch };
    const restartListener =
      (patch.modelDir !== undefined && patch.modelDir !== prev.modelDir) ||
      (patch.whisper !== undefined && patch.whisper !== prev.whisper) ||
      (patch.sttBackend !== undefined && patch.sttBackend !== prev.sttBackend);
    const reconfigureListener =
      !restartListener &&
      ((patch.sttUrl !== undefined && patch.sttUrl !== prev.sttUrl) ||
        (patch.sttModel !== undefined && patch.sttModel !== prev.sttModel) ||
        (patch.sttKey !== undefined && patch.sttKey !== prev.sttKey) ||
        (patch.vadSilenceMs !== undefined && patch.vadSilenceMs !== prev.vadSilenceMs));
    const micChanged = patch.microphone !== undefined && patch.microphone !== prev.microphone;
    const localTtsChanged =
      (patch.localTtsModel !== undefined && patch.localTtsModel !== prev.localTtsModel) ||
      (patch.modelDir !== undefined && patch.modelDir !== prev.modelDir);

    saveSettings(settings);
    this.set({ settings, ready: this.isSttReady(this.state.engine, settings) });

    if (restartListener) this.listener.stop();
    if (reconfigureListener && this.listener.running) {
      const silence = this.wantLiveMode ? Math.max(0.2, settings.vadSilenceMs / 1000) : 0.6;
      this.listener.configure(settings, silence);
    }
    if (micChanged) this.recorder.release();
    if (localTtsChanged) void this.refreshTtsModel();
    if (settings.ttsBackend === "local") void this.speaker.warm();

    if ((restartListener || micChanged) && this.wantLiveMode) void this.setLiveMode(true);
    else if ((restartListener || micChanged) && this.wantHandsFree) void this.setHandsFree(true);
  }

  private async dropHandsFree(reason: string): Promise<void> {
    await this.setHandsFree(false, false);
    this.setStatus(reason, true);
  }

  private async dropLive(reason: string): Promise<void> {
    await this.setLiveMode(false);
    this.setStatus(reason, true);
  }

  private async warmListener(silenceSec?: number): Promise<boolean> {
    if (!this.state.engine?.runtime) return false;
    const settings = this.state.settings;
    if (settings.sttBackend === "local" && !this.state.ready) return false;
    const silence = silenceSec ?? (this.wantLiveMode ? Math.max(0.2, settings.vadSilenceMs / 1000) : 0.6);
    try {
      return await this.listener.ensure(settings, silence);
    } catch {
      return false;
    }
  }

  private handleLevel = (level: number): void => {
    if (this.levelFrame) return;
    this.levelFrame = requestAnimationFrame(() => {
      this.levelFrame = 0;
      this.set({ level });
    });
  };

  /** Turns Live Conversation Mode on/off: continuous no-wake-word dialogue with real barge-in and streaming LLM+TTS. */
  async setLiveMode(on: boolean): Promise<void> {
    this.wantLiveMode = on;
    if (!on) {
      this.clearBargeInTimer();
      this.abortTurn();
      this.speaker.stop();
      if (!this.wantHandsFree) {
        await this.recorder.listen(null);
        this.listener.reset();
      }
      this.set({ liveMode: false, hearing: false, awake: false, opening: false, level: 0 });
      this.syncActivity("");
      return;
    }

    if (this.wantHandsFree) {
      await this.setHandsFree(false, false);
    }

    const settings = this.state.settings;
    if (!this.state.engine?.runtime) {
      this.wantLiveMode = false;
      this.setStatus("Live mode needs the fast speech runtime (Silero VAD). Install it in Settings.", true);
      return;
    }
    if (!this.isSttReady(this.state.engine, settings)) {
      this.wantLiveMode = false;
      this.setStatus("Install the local Whisper model or configure an STT endpoint in Settings first.", true);
      return;
    }
    if (!settings.llmUrl.trim() && !this.deps.decide()) {
      this.wantLiveMode = false;
      this.setStatus("Live mode needs a language model endpoint in Settings.", true);
      return;
    }

    this.set({ opening: true, status: "Starting Live mode...", statusBad: false });
    try {
      const silenceSec = Math.max(0.2, Math.min(1.5, (settings.vadSilenceMs || 420) / 1000));
      const [started] = await Promise.all([this.warmListener(silenceSec), this.speaker.warm()]);
      if (!this.wantLiveMode) return;
      if (!started) throw new Error("The speech runtime did not start.");
      await this.recorder.listen(
        (pcm) => {
          if (this.state.listening) return;
          // Keep feeding VAD during speech playback when barge-in is enabled (WebAudio AEC cancels output!)
          if (this.speaker.speaking && !this.state.settings.bargeIn) return;
          this.listener.feed(pcmBase64(pcm));
        },
        settings.microphone,
        this.handleLevel,
      );
      if (!this.wantLiveMode) {
        await this.recorder.listen(null);
        return;
      }
      this.listener.reset();
      this.speaker.cue("wake");
      this.set({
        liveMode: true,
        handsFree: false,
        opening: false,
        huddlePaused: false,
        status: "Live. Just talk — interrupt anytime.",
        statusBad: false,
      });
      this.syncActivity("");
    } catch (error) {
      if (!this.wantLiveMode) return;
      this.wantLiveMode = false;
      await this.recorder.listen(null);
      this.set({ liveMode: false, opening: false });
      this.setStatus(`Live mode: ${message(error)}`, true);
      this.syncActivity("");
    }
  }

  toggleLiveMode(): void {
    void this.setLiveMode(!this.wantLiveMode);
  }

  async setHandsFree(on: boolean, remember = true): Promise<void> {
    this.wantHandsFree = on;
    if (!on) {
      this.clearBargeInTimer();
      if (!this.wantLiveMode) {
        await this.recorder.listen(null);
        this.listener.reset();
      }
      this.set({ handsFree: false, hearing: false, awake: false, opening: false, level: 0 });
      if (remember && this.state.settings.handsFree) this.updateSettings({ handsFree: false });
      this.syncActivity("");
      return;
    }
    if (this.wantLiveMode) {
      await this.setLiveMode(false);
    }
    if (!this.state.ready || !this.state.engine?.runtime) {
      this.wantHandsFree = false;
      this.setStatus(
        this.state.ready ? "Hands-free needs the fast speech runtime. Install it in Settings." : "Install the speech engine in Settings first.",
        true,
      );
      return;
    }
    this.set({ opening: true, status: "Starting hands-free...", statusBad: false });
    try {
      const started = await this.warmListener(0.6);
      if (!this.wantHandsFree) return;
      if (!started) throw new Error("The speech runtime did not start.");
      await this.recorder.listen(
        (pcm) => {
          if (this.state.listening) return;
          if (this.speaker.speaking && !this.state.settings.bargeIn) return;
          this.listener.feed(pcmBase64(pcm));
        },
        this.state.settings.microphone,
        this.handleLevel,
      );
      if (!this.wantHandsFree) {
        await this.recorder.listen(null);
        return;
      }
      this.listener.reset();
      this.set({ handsFree: true, opening: false, huddlePaused: false, status: `Hands-free. Say “hey ${this.wakeWord()}”.`, statusBad: false });
      if (!this.state.settings.handsFree) this.updateSettings({ handsFree: true });
      this.syncActivity("");
    } catch (error) {
      if (!this.wantHandsFree) return;
      this.wantHandsFree = false;
      await this.recorder.listen(null);
      this.set({ handsFree: false, opening: false });
      this.setStatus(`Hands-free: ${message(error)}`, true);
      this.syncActivity("");
    }
  }

  toggleHandsFree(): void {
    void this.setHandsFree(!this.wantHandsFree);
  }

  private wakeWord(): string {
    return this.state.settings.wakeWord.trim() || "buzz";
  }

  private wake(ms: number): void {
    this.awakeUntil = Date.now() + ms;
    this.set({ awake: true });
    setTimeout(() => {
      if (Date.now() >= this.awakeUntil && this.state.awake) this.set({ awake: false });
    }, ms + 50);
  }

  /** The command after the wake word, "" when only the wake word was said, null when it was not said. */
  private afterWake(text: string): string | null {
    const word = this.wakeWord().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sounds = word === "buzz" ? "buzz|bus|buz|buzzed|bugs" : word;
    const match = new RegExp(`^\\W*(?:(?:hey|hi|ok|okay|a)[\\s,]+)?(?:${sounds})\\b[\\s,.!?:;-]*`, "i").exec(text);
    return match ? text.slice(match[0].length).trim() : null;
  }

  private clearBargeInTimer(): void {
    if (this.bargeInTimer) {
      clearTimeout(this.bargeInTimer);
      this.bargeInTimer = null;
    }
  }

  private abortTurn(): void {
    this.turn += 1;
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
  }

  /** Interrupts active TTS and any in-flight LLM stream/tool turn immediately. */
  interrupt(cue = false): void {
    this.clearBargeInTimer();
    const wasActive = this.speaker.speaking || this.state.busy;
    this.abortTurn();
    this.speaker.stop();
    if (wasActive && cue) this.speaker.cue("interrupt");
    this.set({ busy: false });
    this.syncActivity("");
  }

  private heard(heard: Heard): void {
    if (!this.state.handsFree && !this.state.liveMode) return;

    if (heard.kind === "speech") {
      this.set({ hearing: heard.active });
      this.syncActivity();
      if (heard.active && this.state.settings.bargeIn && (this.speaker.speaking || this.state.busy)) {
        // In Live mode (or when awake in hands-free), brief sustained speech triggers instant barge-in
        const allowBarge = this.state.liveMode || Date.now() < this.awakeUntil;
        if (allowBarge && !this.bargeInTimer) {
          this.bargeInTimer = setTimeout(() => {
            this.bargeInTimer = null;
            if (this.state.hearing && (this.speaker.speaking || this.state.busy)) {
              this.interrupt(true);
              this.setStatus("Listening...");
            }
          }, BARGE_IN_CONFIRM_MS);
        }
      } else if (!heard.active) {
        this.clearBargeInTimer();
      }
      return;
    }

    if (heard.kind === "error") {
      this.setStatus(`Speech: ${heard.message}`, true);
      return;
    }

    const text = heard.text;
    if (!text || /^\[?(blank_audio|silence|music|noise|applause|laughter)\]?$/i.test(text) || /^[\W_]*$/.test(text)) return;

    // Live mode: no wake word needed; every meaningful utterance is a conversational turn
    if (this.state.liveMode) {
      if (NOISE.test(text) && !this.awaitingYesNo && !this.state.pending) return;
      if (this.speaker.speaking || this.state.busy) this.interrupt(false);
      void this.handleTranscript(text);
      return;
    }

    // Wake-word hands-free mode
    const command = this.afterWake(text);
    if (command === null) {
      if (Date.now() >= this.awakeUntil || NOISE.test(text)) return;
      if (this.awaitingYesNo && this.state.pending) {
        if (!NO.test(text) && !YES.test(text)) return;
      } else if (text.split(/\s+/).length < 3) return;
    }
    if (command === "") {
      this.interrupt(true);
      this.wake(FOLLOW_UP_MS);
      this.setStatus("Listening...");
      return;
    }
    this.awakeUntil = 0;
    this.set({ awake: false });
    if (this.speaker.speaking || this.state.busy) this.interrupt(false);
    void this.handleTranscript(command ?? text);
  }

  async refreshEngine(): Promise<void> {
    try {
      const engine = await checkEngine(this.deps.host, this.state.settings);
      this.set({ engine, engineError: "", ready: this.isSttReady(engine, this.state.settings) });
      this.adoptBuzzVoice(engine);
    } catch (error) {
      this.set({
        engine: null,
        engineError: message(error),
        ready: this.isSttReady(null, this.state.settings),
      });
    }
  }

  async refreshTtsModel(): Promise<void> {
    if (!this.state.engine) return;
    const ttsModel = await checkTtsModel(this.deps.host, this.state.settings);
    this.set({ engine: { ...this.state.engine, ttsModel } });
  }

  async installLocalTts(): Promise<void> {
    this.set({ installing: "Downloading local voice model", engineError: "" });
    try {
      const ok = await installTtsModel(this.deps.host, this.state.settings, (step) => {
        this.set({
          installing: step === "runtime" ? "Installing speech runtime" : `Downloading ${this.state.settings.localTtsModel}`,
        });
      });
      const current = this.state.engine ?? { engine: false, model: false, runtime: true, ttsModel: ok, buzzVoice: null };
      this.set({ engine: { ...current, runtime: true, ttsModel: ok }, installing: "" });
      if (ok) void this.speaker.warm();
    } catch (error) {
      this.set({ installing: "", engineError: message(error) });
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

  async installRuntimeOnly(): Promise<void> {
    this.set({ installing: "Installing fast speech runtime", engineError: "" });
    try {
      await installRuntime(this.deps.host, this.state.settings);
      const current = this.state.engine ?? { engine: false, model: false, runtime: true, ttsModel: false, buzzVoice: null };
      const engine = { ...current, runtime: true };
      this.set({ engine, installing: "", ready: this.isSttReady(engine, this.state.settings) });
    } catch (error) {
      this.set({ installing: "", engineError: message(error) });
    }
  }

  async install(): Promise<void> {
    this.set({ installing: "Starting", engineError: "" });
    try {
      const engine = await installEngine(this.deps.host, this.state.settings, (step) =>
        this.set({
          installing:
            step === "engine"
              ? "Downloading the speech engine"
              : step === "runtime"
                ? "Installing fast speech runtime"
                : "Downloading the whisper model",
        }),
      );
      this.set({ engine, installing: "", ready: this.isSttReady(engine, this.state.settings) });
    } catch (error) {
      this.set({ installing: "", engineError: message(error) });
    }
  }

  private setStatus(status: string, bad = false): void {
    this.set({ status, statusBad: bad });
  }

  private say(role: "you" | "app", text: string, extra: Partial<LogEntry> = {}): number {
    const id = this.nextId++;
    const entry: LogEntry = { id, role, text, ...extra };
    this.set({ log: [...this.state.log, entry].slice(-MAX_LOG) });
    this.history.push({ role, text });
    if (this.history.length > HISTORY_TURNS) this.history.splice(0, this.history.length - HISTORY_TURNS);
    return id;
  }

  private updateLogEntry(id: number, patch: Partial<LogEntry>): void {
    const idx = this.state.log.findIndex((entry) => entry.id === id);
    if (idx < 0) return;
    const next = [...this.state.log];
    next[idx] = { ...next[idx], ...patch };
    this.set({ log: next });
  }

  private reply(text: string, opts: { bad?: boolean } = {}): void {
    this.say("app", text, { bad: opts.bad });
    this.setStatus(opts.bad ? text : "", opts.bad);
    this.speaker.speak(text);
  }

  newSession(): void {
    this.interrupt(false);
    this.scope = emptyScope();
    this.history = [];
    this.agentHistory = [];
    this.awaitingYesNo = false;
    this.set({ log: [], pending: null, scope: "", busy: false, status: "" });
    this.syncActivity("");
  }

  stopSpeaking(): void {
    this.interrupt(false);
  }

  voices(): Promise<SystemVoice[]> {
    return listVoices(this.deps.host);
  }

  testVoice(): void {
    this.speaker.stop();
    this.speaker.speak("Hi, this is how Buzz Voice sounds.", true);
  }

  async startListening(): Promise<void> {
    if (this.state.listening || this.state.transcribing) return;
    if (!this.state.ready) {
      this.setStatus("Install the speech engine or configure an STT endpoint in Settings first.", true);
      return;
    }
    if (this.state.opening) return;
    this.interrupt(false);
    this.stopWhenOpen = false;
    if (!this.recorder.open) this.set({ opening: true, status: "Opening the microphone...", statusBad: false });
    try {
      await this.recorder.start(this.handleLevel, this.state.settings.microphone);
      this.set({ opening: false, listening: true, latched: false, status: "Listening...", statusBad: false });
      this.syncActivity("");
      if (this.stopWhenOpen) await this.stopListening();
    } catch (error) {
      this.set({ opening: false });
      this.setStatus(`Microphone: ${message(error)}`, true);
      this.syncActivity("");
    }
  }

  warmMicrophone(): void {
    if (!this.state.ready || this.recorder.open) return;
    void this.recorder.warm(this.state.settings.microphone).catch((error) => {
      this.setStatus(`Microphone: ${message(error)}`, true);
    });
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
    if (this.state.opening) {
      this.stopWhenOpen = true;
      return;
    }
    if (!this.state.listening) return;
    const audio = await this.recorder.stop();
    this.set({ listening: false, latched: false, level: 0, transcribing: true, status: "Transcribing..." });
    this.syncActivity("");
    try {
      if (!audio || audio.seconds < 0.3 || audio.peak < 0.01) {
        this.setStatus("I did not hear anything.");
        return;
      }
      const text = (await this.warmListener())
        ? await this.listener.decode(audio.pcm)
        : await transcribe(this.deps.host, this.state.settings, audio.base64);
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
      this.syncActivity("");
    }
  }

  cancelListening(): void {
    this.recorder.cancel();
    this.set({ listening: false, latched: false, level: 0, status: "" });
    this.syncActivity("");
  }

  submitText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.speaker.speaking || this.state.busy) this.interrupt(false);
    void this.handleTranscript(trimmed);
  }

  private channels(): Channel[] {
    return this.deps.relay()?.channels() ?? [];
  }

  private async people(relay: Relay, channels: Channel[]): Promise<string[]> {
    if (this.peopleCache.length > 0 && Date.now() - this.peopleCacheAt < 5 * 60_000) {
      return this.peopleCache;
    }
    const ids = new Set<string>();
    for (const channel of channels) for (const id of channel.members ?? []) if (id !== relay.pubkey) ids.add(id);
    const names = await relay.profiles([...ids].slice(0, 400));
    this.peopleCache = [...new Set(names.values())].filter(Boolean).sort();
    this.peopleCacheAt = Date.now();
    return this.peopleCache;
  }

  async handleTranscript(text: string): Promise<void> {
    this.say("you", text);
    const relay = this.deps.relay();
    if (!relay) {
      this.reply("Buzz is not connected yet.", { bad: true });
      return;
    }

    // Fast-path exact yes/no when awaiting confirmation
    if (this.awaitingYesNo && this.state.pending) {
      const words = text.trim().split(/\s+/).length;
      if (words <= 5 && NO.test(text) && !YES.test(text)) {
        this.awaitingYesNo = false;
        this.cancel();
        return;
      }
      if (words <= 5 && YES.test(text) && !NO.test(text)) {
        this.awaitingYesNo = false;
        await this.publish();
        return;
      }
    }

    // Use the conversational streaming tool-calling brain whenever an LLM is configured
    if (this.state.settings.llmUrl.trim()) {
      await this.converse(relay, text);
      return;
    }

    // Fallback to classic Decisions-API router when no LLM URL is configured
    if (this.awaitingYesNo && this.state.pending) {
      this.awaitingYesNo = false;
      this.cancel();
    }
    await this.route(relay, text);
  }

  private buildAgentContext(relay: Relay): AgentContextSnapshot {
    const channels = this.channels();
    if (this.peopleCache.length === 0) void this.refreshPeopleCache(relay);

    const scopeLines: string[] = [];
    if (this.scope.channel) scopeLines.push(`Channel: ${this.scope.channel.name}`);
    if (this.scope.threads.length > 0) {
      scopeLines.push("Threads (1-based):");
      this.scope.threads.forEach((t, i) => {
        const star = this.scope.focus?.rootId === t.rootId ? " [focused]" : "";
        scopeLines.push(`  ${i + 1}. ${t.label}${t.who.length ? ` (${t.who.join(", ")})` : ""}${star}`);
      });
    }

    const pending = this.state.pending;
    let pendingSummary = "";
    if (pending) {
      pendingSummary = pending.todo
        ? `Todo (${pending.todo.op}) in #${pending.channel.name}: "${pending.todo.label}"${pending.todo.assignee ? ` assigned to ${pending.todo.assignee.name}` : ""}`
        : `Message to #${pending.channel.name}${pending.label ? ` (replying in "${pending.label}")` : " (new thread)"}: "${pending.body}"`;
    }

    const watchesSummary = this.state.watches
      .slice(0, 5)
      .map((w) => `- #${w.channelName}: ${w.label}`)
      .join("\n");

    return {
      channels: channels.map((c) => ({ name: c.name, description: c.description })),
      people: this.peopleCache,
      scopeSummary: scopeLines.join("\n"),
      pendingSummary,
      watchesSummary,
      confirmBeforeSend: this.state.settings.confirmBeforeSend,
    };
  }

  private pushAgentHistory(messages: AgentMessage[]): void {
    this.agentHistory.push(...messages);
    if (this.agentHistory.length > AGENT_HISTORY_MAX) {
      // Keep trim boundary on a user message so tool_call/tool pairs stay intact
      let cut = this.agentHistory.length - AGENT_HISTORY_MAX;
      while (cut < this.agentHistory.length && this.agentHistory[cut].role !== "user") cut += 1;
      this.agentHistory = cut < this.agentHistory.length ? this.agentHistory.slice(cut) : this.agentHistory.slice(-8);
    }
  }

  /** Streaming conversational tool-calling loop with live bubble updates and instant barge-in abort. */
  private async converse(relay: Relay, text: string): Promise<void> {
    this.abortTurn();
    const ticket = this.turn;
    const abort = new AbortController();
    this.activeAbort = abort;
    const live = () => ticket === this.turn && !abort.signal.aborted;

    this.set({ busy: true });
    this.syncActivity("Thinking...");
    this.setStatus("Thinking...");

    const userMsg: AgentMessage = { role: "user", content: text };
    const baseHistory = [...this.agentHistory, userMsg];
    let bubbleId: number | null = null;

    try {
      const result = await runAgentTurn({
        host: this.deps.host,
        settings: this.state.settings,
        history: baseHistory,
        context: () => this.buildAgentContext(relay),
        executeTool: (name, args) => this.executeAgentTool(relay, name, args, live),
        onActivity: (label) => {
          if (!live()) return;
          this.setStatus(label);
          this.syncActivity(label);
        },
        onTextUpdate: (accumulated) => {
          if (!live() || !accumulated) return;
          if (bubbleId === null) {
            bubbleId = this.say("app", accumulated, { streaming: true });
          } else {
            this.updateLogEntry(bubbleId, { text: accumulated, streaming: true });
          }
        },
        onSpeak: (sentence) => {
          if (!live()) return;
          this.speaker.speak(sentence);
        },
        signal: abort.signal,
      });

      if (bubbleId !== null) {
        this.updateLogEntry(bubbleId, { streaming: false });
      }

      if (result.aborted) {
        const partial = result.spoken.trim();
        this.pushAgentHistory([
          userMsg,
          ...(partial ? [{ role: "assistant" as const, content: `${partial} [interrupted by user]` }] : []),
        ]);
        return;
      }

      this.pushAgentHistory([userMsg, ...result.newMessages]);
      if (result.spoken && bubbleId === null) {
        this.say("app", result.spoken);
      }
      if (live()) {
        this.setStatus(this.state.liveMode ? "Live. Just talk — interrupt anytime." : "");
      }
    } catch (error) {
      if (bubbleId !== null) this.updateLogEntry(bubbleId, { streaming: false });
      if (live()) {
        this.reply(message(error), { bad: true });
      }
    } finally {
      if (this.activeAbort === abort) this.activeAbort = null;
      if (ticket === this.turn) {
        this.set({ busy: false });
        this.syncActivity("");
      }
    }
  }

  private async executeAgentTool(
    relay: Relay,
    name: string,
    args: Record<string, unknown>,
    live: () => boolean,
  ): Promise<{ result: string }> {
    const channels = this.channels();
    const resolveChan = (spokenName?: unknown): Channel | null => {
      const s = typeof spokenName === "string" ? spokenName.trim() : "";
      if (s) return matchChannel(channels, s, s);
      return this.scope.channel;
    };

    switch (name) {
      case "list_channels": {
        const list = channels.map((c) => `${c.name}${c.description ? ` — ${c.description.slice(0, 100)}` : ""}`);
        return { result: list.length ? list.join("\n") : "No channels found." };
      }

      case "read_channel": {
        const channel = resolveChan(args.channel);
        if (!channel) return { result: `No channel matched "${String(args.channel ?? "")}".` };
        const limit = Math.max(1, Math.min(15, Number(args.limit) || 8));
        const all = await relay.threads(channel.id);
        if (!live()) return { result: "Aborted." };
        if (all.length === 0) {
          this.scope = setThreads(this.scope, channel, [], null);
          this.paintScope();
          return { result: `#${channel.name} has no messages.` };
        }
        const recent = all.slice(-limit);
        const names = await relay.profiles([...new Set(recent.flatMap((t) => t.messages.map((m) => m.pubkey)))]);
        const described = recent.map((t) => describeThread(t, names));
        this.scope = setThreads(this.scope, channel, described, described[described.length - 1] ?? null);
        this.paintScope();
        const blocks = recent.map((t, i) => block(t, i, names));
        return { result: `Channel #${channel.name} (${recent.length} recent threads, oldest first):\n\n${blocks.join("\n\n")}` };
      }

      case "read_thread": {
        const channel = resolveChan(args.channel);
        if (!channel) return { result: "No channel specified or in focus." };
        const ref = typeof args.thread_ref === "number" ? args.thread_ref : null;
        const hint = typeof args.thread_hint === "string" && args.thread_hint.trim() ? args.thread_hint.trim() : null;
        let target = resolveThread(this.scope, channel, ref);
        if (!target || hint) {
          const all = await relay.threads(channel.id);
          if (!live()) return { result: "Aborted." };
          if (all.length === 0) return { result: `#${channel.name} has no threads.` };
          const recent = all.slice(-12);
          const names = await relay.profiles([...new Set(recent.flatMap((t) => t.messages.map((m) => m.pubkey)))]);
          const owned = recent.map((t) => ({ ...describeThread(t, names), channelId: channel.id, channelName: channel.name }));
          if (hint) {
            const picked = await pickThread({
              llm: this.llm(),
              decide: this.deps.decide(),
              community: this.deps.community(),
              channelName: channel.name,
              hint,
              transcript: hint,
              labels: owned.map((t) => t.label),
            }).catch(() => null);
            target = picked ? owned[picked - 1] : owned[owned.length - 1];
          } else {
            target = owned[owned.length - 1];
          }
          this.scope = setThreads(this.scope, channel, owned, target);
          this.paintScope();
        }
        const [root, replies] = await Promise.all([
          relay.byIds([target.rootId]),
          relay.messagesInThread(channel.id, target.rootId),
        ]);
        if (!live()) return { result: "Aborted." };
        const messages = [...root, ...replies]
          .filter((e, i, list) => list.findIndex((x) => x.id === e.id) === i)
          .sort((a, b) => a.created_at - b.created_at);
        const names = await relay.profiles([...new Set(messages.map((m) => m.pubkey))]);
        const one: Thread = {
          rootId: target.rootId,
          messages: messages.slice(-24),
          lastAt: messages.at(-1)?.created_at ?? now(),
        };
        this.scope = { ...this.scope, channel, focus: target };
        this.paintScope();
        this.watch({ rootId: target.rootId, channelId: channel.id, channelName: channel.name, label: target.label, since: one.lastAt });
        return { result: `Thread in #${channel.name} ("${target.label}"):\n${block(one, 0, names)}` };
      }

      case "check_inbox": {
        const days = Math.max(1, Math.min(14, Number(args.days) || INBOX_DAYS));
        const since = now() - days * 86400;
        const mentions = await relay.mentions(since);
        if (!live()) return { result: "Aborted." };
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
          return { result: "Inbox is clear. Zero unread mentions." };
        }
        const names = await relay.profiles([...new Set(unread.flatMap(([, item]) => item.events.map((e) => e.pubkey)))]);
        const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? "a channel";
        const described: ScopeThread[] = unread.map(([root, item]) => {
          const last = item.events[item.events.length - 1];
          return {
            rootId: root,
            channelId: item.channelId,
            channelName: channelName(item.channelId),
            label: plain(last.content).slice(0, 70) || root.slice(0, 8),
            who: [...new Set(item.events.map((e) => names.get(e.pubkey) ?? e.pubkey.slice(0, 8)))],
            lastAt: last.created_at,
          };
        });
        const top = described[described.length - 1] ?? null;
        const home = top ? (channels.find((c) => c.id === top.channelId) ?? null) : null;
        this.scope = setItems(home ?? this.scope.channel, described, top);
        this.paintScope();
        const blocks = unread.map(([, item], index) => {
          const lines = item.events.slice(-4).map((e) => {
            const who = names.get(e.pubkey) ?? e.pubkey.slice(0, 8);
            return `  ${who}: ${e.content.replace(/\s+/g, " ").slice(0, 400)}`;
          });
          return `Unread ${index + 1} in #${channelName(item.channelId)}:\n${lines.join("\n")}`;
        });
        return { result: `${unread.length} unread thread(s):\n\n${blocks.join("\n\n")}` };
      }

      case "list_todos": {
        const channel = resolveChan(args.channel);
        if (!channel) return { result: "No channel specified or in focus." };
        const head = await relay.readCanvas(channel.id);
        const items = readTodos(head?.content ?? "").items;
        if (items.length === 0) return { result: `#${channel.name} has no todos.` };
        const lines = items.map((item) => {
          const who = item.assignee?.name ?? item.namedAssignee?.name;
          return `[${item.status}] ${plain(item.label)}${who ? ` (@${who})` : ""}`;
        });
        return { result: `Todos in #${channel.name} (${items.length} total):\n${lines.join("\n")}` };
      }

      case "draft_message": {
        const channel = resolveChan(args.channel);
        if (!channel) return { result: `Could not find channel "${String(args.channel ?? "")}". Ask the user which channel.` };
        const rawMsg = String(args.message ?? "").trim();
        if (!rawMsg) return { result: "Message body is empty." };
        const newThread = args.new_thread === true;
        const ref = typeof args.thread_ref === "number" ? args.thread_ref : null;
        const hint = typeof args.thread_hint === "string" && args.thread_hint.trim() ? args.thread_hint.trim() : null;
        let target: ScopeThread | null = null;
        if (!newThread) {
          target = resolveThread(this.scope, channel, ref);
          if (!target || hint) {
            const fakeIntent: Intent = {
              action: "post",
              todo_op: "add",
              channel: channel.name,
              recipient: null,
              continues_previous: false,
              thread: "existing",
              thread_ref: ref,
              thread_hint: hint,
              new_thread: false,
              instruction: rawMsg,
              filter: "all",
              spoken_confirmation: "",
            };
            target = await this.findThread(relay, channel, fakeIntent, hint ?? rawMsg);
          }
        }
        if (!live()) return { result: "Aborted." };
        const members = await this.rankedMembers(relay, channel, target?.rootId ?? null);
        if (!live()) return { result: "Aborted." };
        const recipientSpoken = typeof args.recipient === "string" && args.recipient.trim() ? args.recipient.trim() : null;
        const mention = recipientSpoken ? bestPerson(members, (m) => m.name, recipientSpoken, rawMsg) : null;
        const addressed = mention?.name ?? recipientSpoken;
        const body = addressed && !rawMsg.toLowerCase().startsWith(`@${addressed.toLowerCase()}`) ? `@${addressed} ${rawMsg}` : rawMsg;

        const pending: Pending = {
          todo: null,
          channel,
          replyTo: target?.rootId ?? null,
          label: target?.label ?? null,
          orphaned: !newThread && !target,
          body,
          addressed,
          members,
        };
        this.set({ pending });
        if (!this.state.settings.confirmBeforeSend) {
          await this.publish(true);
          return { result: `Sent to #${channel.name}${target ? ` in thread "${target.label}"` : ""}: "${body}". Now watching for replies.` };
        }
        this.awaitingYesNo = true;
        return {
          result: `Draft staged for #${channel.name}${target ? ` in thread "${target.label}"` : " (new thread)"}: "${body}". Waiting for user confirmation.`,
        };
      }

      case "send_draft": {
        if (!this.state.pending) return { result: "There is no pending draft to send." };
        const desc = this.state.pending.todo
          ? `${this.state.pending.todo.op} todo "${this.state.pending.todo.label}" in #${this.state.pending.channel.name}`
          : `message to #${this.state.pending.channel.name}`;
        await this.publish(true);
        return { result: `Published ${desc}.` };
      }

      case "cancel_draft": {
        if (!this.state.pending) return { result: "There was no pending draft." };
        this.awaitingYesNo = false;
        this.set({ pending: null });
        return { result: "Draft cancelled." };
      }

      case "manage_todo": {
        const channel = resolveChan(args.channel);
        if (!channel) return { result: `Could not find channel "${String(args.channel ?? "")}".` };
        const op = String(args.op ?? "add") as Exclude<TodoOp, "list">;
        const phrase = String(args.label ?? "").trim().replace(/[.!?]+$/, "");
        if (!phrase) return { result: "No todo label provided." };
        const head = await relay.readCanvas(channel.id);
        if (!live()) return { result: "Aborted." };
        const items = readTodos(head?.content ?? "").items;
        let existing: Todo | null = null;
        if (op !== "add") {
          const status = op === "assign" ? null : OP_STATUS[op];
          existing = findTodo(items, phrase, status ? (item) => item.status !== status : undefined);
          if (!existing) return { result: `No todo in #${channel.name} matched "${phrase}".` };
        }
        const hint = typeof args.thread_hint === "string" && args.thread_hint.trim() ? args.thread_hint.trim() : null;
        const target = resolveThread(this.scope, channel, null) ?? (hint ? await this.findThread(relay, channel, {
          action: "todo",
          todo_op: op,
          channel: channel.name,
          recipient: null,
          continues_previous: false,
          thread: "existing",
          thread_ref: null,
          thread_hint: hint,
          new_thread: false,
          instruction: phrase,
          filter: "all",
          spoken_confirmation: "",
        }, hint) : null);
        const members = await this.rankedMembers(relay, channel, target?.rootId ?? null);
        const assigneeSpoken = typeof args.assignee === "string" && args.assignee.trim() ? args.assignee.trim() : null;
        const assignee = assigneeSpoken ? bestPerson(members, (m) => m.name, assigneeSpoken, phrase) : null;
        if (assigneeSpoken && !assignee) return { result: `Nobody called "${assigneeSpoken}" is in #${channel.name}.` };
        if (op === "assign" && !assignee) return { result: "Need an assignee name." };

        const label = existing?.label ?? phrase.charAt(0).toUpperCase() + phrase.slice(1);
        const body = assignee && (op === "add" || op === "assign") ? `@${assignee.name} ${label}` : "";
        const pending: Pending = {
          todo: { op, label, offset: existing?.offset ?? null, assignee },
          channel,
          replyTo: target?.rootId ?? null,
          label: target?.label ?? null,
          orphaned: false,
          body,
          addressed: assignee?.name ?? null,
          members,
        };
        this.set({ pending });
        if (!this.state.settings.confirmBeforeSend) {
          await this.publish(true);
          return { result: `Saved todo (${op}) "${label}" in #${channel.name}${assignee ? ` for ${assignee.name}` : ""}.` };
        }
        this.awaitingYesNo = true;
        return { result: `Todo draft staged (${op}) "${label}" in #${channel.name}${assignee ? ` for ${assignee.name}` : ""}. Waiting for user confirmation.` };
      }

      case "tracked_status": {
        await this.refreshTracked(relay);
        const filter = (typeof args.filter === "string" ? args.filter : "all") as ThreadState | "all";
        return { result: this.summarizeTracked(filter) };
      }

      case "flag_thread": {
        const emoji = String(args.emoji ?? "").replace(/\uFE0F/g, "").trim();
        if (!emoji) return { result: "No emoji provided." };
        const channel = resolveChan(args.channel);
        const ref = typeof args.thread_ref === "number" ? args.thread_ref : null;
        const target = channel ? resolveThread(this.scope, channel, ref) : this.scope.focus;
        if (!target) return { result: "No thread is in focus to flag." };
        if (!relay.canReact()) return { result: "This Buzz connection cannot add reactions." };
        const [root] = await relay.byIds([target.rootId]);
        if (!root) return { result: "Could not find the thread root message." };
        relay.react(root, emoji);
        return { result: `Flagged "${target.label}" in #${target.channelName || channel?.name || "channel"} with ${emoji}.` };
      }

      default:
        return { result: `Unknown tool "${name}".` };
    }
  }

  private async route(relay: Relay, text: string): Promise<void> {
    const ticket = ++this.turn;
    const live = () => ticket === this.turn;
    this.set({ busy: true });
    this.syncActivity("Working out what you meant...");
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

      if (intent.action === "todo") {
        const home = channel ?? matchChannel(channels, null, text);
        if (!home) {
          this.reply(intent.channel ? `There is no channel called ${intent.channel}.` : "Which channel's todo list?", { bad: true });
          return;
        }
        return await this.planTodo(relay, home, intent, text, live);
      }

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

      const target = intent.new_thread
        ? null
        : (resolveThread(this.scope, channel, intent.thread_ref) ?? (await this.findThread(relay, channel, intent, text)));
      if (!live()) return;
      const members = await this.rankedMembers(relay, channel, target?.rootId ?? null);
      if (!live()) return;
      const mention = intent.recipient ? bestPerson(members, (m) => m.name, intent.recipient, text) : null;
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
          members,
        },
      });
      if (!this.state.settings.confirmBeforeSend) {
        await this.publish();
        return;
      }
      this.setStatus("Edit it if you need to, then send. Or say yes.");
      this.speaker.speak(intent.spoken_confirmation || `Send to ${channel.name}?`);
      this.awaitingYesNo = true;
    } catch (error) {
      if (live()) this.reply(message(error), { bad: true });
    } finally {
      if (live()) {
        this.set({ busy: false });
        this.syncActivity("");
      }
    }
  }

  private async planTodo(relay: Relay, channel: Channel, intent: Intent, text: string, live: () => boolean): Promise<void> {
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
    let existing: Todo | null = null;
    if (intent.todo_op !== "add") {
      const status = intent.todo_op === "assign" ? null : OP_STATUS[intent.todo_op];
      existing = findTodo(items, phrase, status ? (item) => item.status !== status : undefined);
      if (!existing) {
        this.reply(`No todo in ${channel.name} matches “${phrase}”.`, { bad: true });
        return;
      }
    }
    const scoped = intent.new_thread ? null : resolveThread(this.scope, channel, intent.thread_ref);
    const target = scoped ?? (intent.thread_hint ? await this.findThread(relay, channel, intent, text) : null);
    if (!live()) return;
    const members = await this.rankedMembers(relay, channel, target?.rootId ?? null);
    if (!live()) return;
    const assignee = intent.recipient ? bestPerson(members, (m) => m.name, intent.recipient, text) : null;
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
        members,
      },
    });
    if (!this.state.settings.confirmBeforeSend) {
      await this.publish();
      return;
    }
    const verb = { add: "Add", assign: "Assign", start: "Start", done: "Finish", reopen: "Reopen" }[op];
    const who = assignee && (op === "add" || op === "assign") ? ` for ${assignee.name}` : "";
    this.setStatus("Edit it if you need to, then confirm. Or say yes.");
    this.speaker.speak(`${verb} ${plain(label)}${who} in ${channel.name}?`);
    this.awaitingYesNo = true;
  }

  private readTodoList(channel: Channel, items: Todo[]): void {
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

  editTodoLabel(label: string): void {
    const pending = this.state.pending;
    if (!pending?.todo || pending.todo.op !== "add") return;
    const body = pending.todo.assignee ? `@${pending.todo.assignee.name} ${label}` : "";
    this.set({ pending: { ...pending, todo: { ...pending.todo, label }, body: pending.body ? body : "" } });
  }

  assignPending(member: Member | null): void {
    const pending = this.state.pending;
    if (!pending?.todo) return;
    const body = member ? `@${member.name} ${pending.todo.label}` : "";
    this.set({ pending: { ...pending, todo: { ...pending.todo, assignee: member }, body, addressed: member?.name ?? null } });
  }

  private async publishTodo(relay: Relay, pending: Pending, silent = false): Promise<void> {
    const todo = pending.todo!;
    const { channel, replyTo } = pending;
    const label = todo.op === "add" ? todo.label.replace(/\s+/g, " ").trim() : todo.label;
    if (!label) return;
    this.setStatus(`Updating the ${channel.name} todos...`);
    await relay.editCanvas(channel.id, (content) => {
      if (todo.op === "add") {
        const next = addTodo(content, label);
        if (!todo.assignee) return next;
        const added = readTodos(next).items.find((item) => item.label === label && !item.assignee && !item.namedAssignee);
        if (!added) throw new Error("Could not find the new todo to assign it.");
        return assignTodo(next, added.offset, todo.assignee);
      }
      const items = readTodos(content).items;
      const same = items.filter((i) => i.label === label);
      const item = same.find((i) => i.offset === todo.offset) ?? (same.length === 1 ? same[0] : undefined);
      if (!item) throw new Error(`“${label}” is no longer on the ${channel.name} list.`);
      if (todo.op === "assign") return assignTodo(content, item.offset, todo.assignee ?? undefined);
      return setStatus(content, item.offset, OP_STATUS[todo.op]);
    });
    const done = { add: "Added", assign: "Assigned", start: "Started", done: "Done", reopen: "Reopened" }[todo.op];
    const body = pending.body.trim();
    const mentioned = mentionsIn(body, pending.members);
    if (!body || mentioned.length === 0) {
      this.say("app", label, { meta: `${done} in ${channel.name} todos` });
      this.setStatus("");
      if (!silent) this.speaker.speak(`${done}.`);
      return;
    }
    const event = relay.postMessage({
      channelId: channel.id,
      content: body,
      mentions: mentioned.map((m) => m.pubkey),
      replyTo: replyTo ?? undefined,
    });
    const rootId = replyTo ?? event.id;
    this.watch({ rootId, channelId: channel.id, channelName: channel.name, label: body, since: event.created_at });
    this.say("app", body, {
      meta: `${done} in ${channel.name} todos, told ${mentioned.map((m) => m.name).join(", ")}`,
      link: { channelId: channel.id, messageId: event.id, rootId },
    });
    this.setStatus(`${done}. Watching for a reply.`);
    if (!silent) this.speaker.speak(`${done}, and told ${mentioned[0].name}.`);
  }

  private async rankedMembers(relay: Relay, channel: Channel, rootId: string | null): Promise<Member[]> {
    const [roster, recent, thread] = await Promise.all([
      relay.members(channel).catch(() => [] as Member[]),
      relay.threads(channel.id, 120).catch(() => [] as Thread[]),
      rootId
        ? Promise.all([relay.byIds([rootId]), relay.messagesInThread(channel.id, rootId)])
            .then(([root, replies]) => [...root, ...replies])
            .catch(() => [] as Event[])
        : Promise.resolve([] as Event[]),
    ]);
    const lastSeen = (events: Event[]) => {
      const at = new Map<string, number>();
      for (const event of events) {
        if (event.pubkey === relay.pubkey) continue;
        at.set(event.pubkey, Math.max(at.get(event.pubkey) ?? 0, event.created_at));
      }
      return [...at.entries()].sort((a, b) => b[1] - a[1]).map(([pubkey]) => pubkey);
    };
    const order = [
      ...lastSeen(thread),
      ...lastSeen(recent.flatMap((t) => t.messages)),
      ...roster.map((m) => m.pubkey),
    ];
    const unique = [...new Set(order)];
    const names = await relay.profiles(unique.filter((pubkey) => !roster.some((m) => m.pubkey === pubkey)));
    for (const member of roster) names.set(member.pubkey, member.name);
    return unique.map((pubkey) => ({ pubkey, name: names.get(pubkey) ?? "" })).filter((m) => m.name);
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
        label: plain(last.content).slice(0, 70) || root.slice(0, 8),
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

  async publish(silent = false): Promise<void> {
    const relay = this.deps.relay();
    const pending = this.state.pending;
    if (!relay || !pending) return;
    if (pending.todo) {
      this.awaitingYesNo = false;
      this.set({ pending: null });
      try {
        await this.publishTodo(relay, pending, silent);
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
          label: plain(body).slice(0, 70),
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
      if (!silent) this.speaker.speak("Posted.");
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
    this.syncWatchObserver();
  }

  unwatch(rootId: string): void {
    const watches = this.state.watches.filter((w) => w.rootId !== rootId);
    saveJson(WATCH_KEY, watches);
    this.set({ watches });
    this.syncWatchObserver();
  }

  isWatching(rootId: string): boolean {
    return this.state.watches.some((w) => w.rootId === rootId);
  }

  private async ingestReplies(relay: Relay, events: Event[]): Promise<void> {
    const live = this.state.watches.filter((w) => w.until > now());
    if (live.length === 0) return;
    const byRoot = new Map(live.map((w) => [w.rootId, w]));
    const fresh: { watch: Watch; event: Event }[] = [];
    for (const event of events) {
      if (event.pubkey === relay.pubkey || this.seenReplyIds.has(event.id)) continue;
      const watch = byRoot.get(rootOf(event)) ?? byRoot.get(event.id);
      if (!watch || event.created_at <= watch.since) continue;
      this.seenReplyIds.add(event.id);
      fresh.push({ watch, event });
    }
    if (fresh.length === 0) return;
    if (this.seenReplyIds.size > 500) {
      this.seenReplyIds = new Set([...this.seenReplyIds].slice(-250));
    }

    const names = await relay.profiles([...new Set(fresh.map((f) => f.event.pubkey))]);
    const seen = new Map<string, number>();
    for (const { watch, event } of fresh) {
      seen.set(watch.rootId, Math.max(seen.get(watch.rootId) ?? 0, event.created_at));
    }
    const watches = this.state.watches.map((w) => (seen.has(w.rootId) ? { ...w, since: seen.get(w.rootId) as number } : w));
    saveJson(WATCH_KEY, watches);
    this.set({ watches });

    const channels = this.channels();
    for (const { watch, event } of fresh.sort((a, b) => a.event.created_at - b.event.created_at)) {
      const who = names.get(event.pubkey) ?? event.pubkey.slice(0, 8);
      this.say("app", event.content, {
        meta: `${who} in ${watch.channelName}`,
        link: { channelId: watch.channelId, messageId: event.id, rootId: watch.rootId },
      });
      this.tracked = this.tracked.map((t) =>
        t.rootId === watch.rootId ? { ...t, lastReply: event.content.replace(/\s+/g, " ").slice(0, 240) } : t,
      );

      // Put the incoming reply's thread into conversational focus so the user can reply immediately!
      const ch = channels.find((c) => c.id === watch.channelId) ?? { id: watch.channelId, name: watch.channelName };
      this.scope = rememberPost(this.scope, ch, {
        rootId: watch.rootId,
        channelId: watch.channelId,
        channelName: watch.channelName,
        label: watch.label,
        who: [who],
        lastAt: event.created_at,
      });
      this.paintScope();
      this.pushAgentHistory([
        {
          role: "user",
          content: `[Incoming reply from ${who} in #${watch.channelName} on thread "${watch.label}"]: ${event.content.slice(0, 800)}`,
        },
      ]);

      if (!this.state.listening && !this.state.hearing) {
        await this.announceReply(who, watch.channelName, event.content);
      }
    }
    saveJson(TRACK_KEY, this.tracked.slice(0, 100));
  }

  private async announceReply(who: string, channelName: string, content: string): Promise<void> {
    const clean = spoken(who, channelName, content);
    const startTurn = this.turn;
    // Summarize long replies into 1-2 crisp spoken sentences when LLM is available
    if (content.length > 220 && this.state.settings.llmUrl.trim() && this.state.settings.speak) {
      try {
        const sentences = new SentenceBuffer();
        const abort = new AbortController();
        await llmStream(
          this.deps.host,
          this.state.settings,
          {
            model: this.state.settings.llmModel || "default",
            max_tokens: 120,
            chat_template_kwargs: { enable_thinking: false },
            messages: [
              {
                role: "system",
                content:
                  "Summarize this incoming Buzz reply out loud in 1 to 2 short plain-text sentences (under 30 words). Start with who replied and in which channel. No markdown.",
              },
              { role: "user", content: `${who} in #${channelName}:\n${content.slice(0, 1500)}` },
            ],
          },
          (delta) => {
            if (this.turn !== startTurn || this.state.hearing) {
              abort.abort();
              return;
            }
            sentences.push(delta, (s) => this.speaker.speak(s));
          },
          abort.signal,
        );
        if (this.turn === startTurn && !this.state.hearing) {
          sentences.flush((s) => this.speaker.speak(s));
        }
        return;
      } catch {
        if (this.turn !== startTurn || this.state.hearing) return;
      }
    }
    if (this.turn === startTurn && !this.state.hearing) this.speaker.speak(clean);
  }

  private async tick(): Promise<void> {
    const relay = this.deps.relay();
    if (!relay || this.polling) return;
    const live = this.state.watches.filter((w) => w.until > now());
    if (live.length !== this.state.watches.length) {
      saveJson(WATCH_KEY, live);
      this.set({ watches: live });
      this.syncWatchObserver();
    }
    if (live.length === 0) return;
    this.polling = true;
    try {
      if (this.watchObserver) {
        await this.watchObserver.refresh().catch(() => undefined);
      } else {
        const since = Math.min(...live.map((w) => w.since)) + 1;
        const events = await relay.repliesIn(live.map((w) => w.rootId), since);
        await this.ingestReplies(relay, events);
      }
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
