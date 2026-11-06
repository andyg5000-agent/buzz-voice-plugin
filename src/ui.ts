import { mentionsIn, type Controller, type LogEntry, type VoiceState } from "./controller";
import { emojiCounts, emptyFlagSource, groupFlags, loadFlags, type Flag, type FlagSource } from "./flags";
import type { Relay } from "./relay";

const TAP_MS = 400;
const FLAG_REFRESH_MS = 60_000;

export interface Connection {
  status: string;
  session?: any;
  scope?: string;
  viewer?: string;
  generation?: number;
  error?: string;
}

export interface UiDeps {
  React: any;
  controller: Controller;
  relayService: { subscribe(listener: () => void): () => void; snapshot(): Connection };
  relay: () => Relay | null;
  navigation: { open(target: unknown): Promise<{ status: string } | undefined> };
}

export function scopeOf(connection: Connection): { communityOrigin: string; viewer: string } | undefined {
  const scope = connection.scope ?? "";
  const at = scope.lastIndexOf(":");
  if (at < 0 || scope.slice(at + 1) !== connection.viewer) return undefined;
  return { communityOrigin: scope.slice(0, at), viewer: connection.viewer as string };
}

function ago(seconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

const row = { display: "flex", gap: "var(--space-2, 8px)", alignItems: "center", flexWrap: "wrap" as const };
const muted = { opacity: 0.7, fontSize: "0.9em" };
const card = { padding: "var(--space-panel-inset, 16px)", marginBottom: "var(--space-4, 16px)" };
const item = { padding: "var(--space-2, 8px) 0", borderTop: "1px solid var(--color-border, rgba(127,127,127,0.25))" };
const bad = { color: "var(--color-danger, #c0392b)" };

export function createUi(deps: UiDeps) {
  const { React, controller, relayService, navigation } = deps;
  const h = React.createElement;
  const { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } = React;

  const useVoice = (): VoiceState => useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const useConnection = (): Connection =>
    useSyncExternalStore(relayService.subscribe, relayService.snapshot, relayService.snapshot);

  function openTarget(channelId: string, messageId: string, rootId: string): void {
    const scope = scopeOf(relayService.snapshot());
    if (!scope) return;
    void navigation.open({ version: 1, kind: "conversation", scope, channelId, messageId, threadRootId: rootId });
  }

  function Setup({ voice }: { voice: VoiceState }) {
    if (voice.ready) return null;
    const engine = voice.engine;
    return h(
      "section",
      { className: "ui-card", style: card },
      h("h2", null, "Set up speech"),
      h(
        "p",
        null,
        "Speech is transcribed on this Mac with the same sherpa-onnx whisper model Buzz Voice uses. Nothing is sent anywhere.",
      ),
      engine &&
        h(
          "p",
          { style: muted },
          `Engine: ${engine.engine ? "installed" : "missing"}. Model (${voice.settings.whisper}): ${engine.model ? "installed" : "missing"}. Folder: ${voice.settings.modelDir}`,
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
            onClick: () => void controller.install(),
          },
          voice.installing ? `${voice.installing}...` : "Install speech engine",
        ),
        h("button", { type: "button", className: "ui-button", onClick: () => void controller.refreshEngine() }, "Check again"),
      ),
    );
  }

  function TalkButton({ voice }: { voice: VoiceState }) {
    const pressedAt = useRef(0);
    const label = voice.transcribing
      ? "Transcribing..."
      : voice.listening
        ? voice.latched
          ? "Recording. Tap to stop"
          : "Listening. Release to send"
        : "Tap or hold to talk";
    const down = (event: any) => {
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
          "aria-pressed": voice.listening,
        },
        `🎙 ${label}`,
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
            overflow: "hidden",
          },
        },
        h("span", {
          style: {
            display: "block",
            height: "100%",
            width: `${Math.round(level * 100)}%`,
            background: "var(--color-accent, #2e86de)",
            transition: "width 60ms linear",
          },
        }),
      ),
      h("span", { style: muted }, "Shortcut: Cmd+Shift+Space"),
    );
  }

  function PendingCard({ voice }: { voice: VoiceState }) {
    const pending = voice.pending;
    const ref = useRef(null as any);
    useEffect(() => {
      ref.current?.focus();
    }, [pending?.channel.id, pending?.replyTo]);
    if (!pending) return null;
    const found = mentionsIn(pending.body, pending.members);
    const note = found.length
      ? `Notifies ${found.map((m) => m.name).join(", ")}`
      : pending.body.includes("@")
        ? "Nobody in this channel matches that name. Nobody will be notified."
        : "Nobody will be notified.";
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return h(
      "div",
      { className: "ui-card", style: { ...card, border: "1px solid var(--color-accent, #2e86de)" } },
      h("strong", null, pending.label ? `#${pending.channel.name} · in "${pending.label}"` : `#${pending.channel.name}`),
      h("textarea", {
        ref,
        "aria-label": "Message to send",
        value: pending.body,
        rows: Math.min(8, Math.max(2, Math.ceil(pending.body.length / 70))),
        spellCheck: false,
        style: { display: "block", width: "100%", margin: "var(--space-2, 8px) 0" },
        onChange: (event: any) => controller.editPending(event.target.value),
        onKeyDown: (event: any) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void controller.publish();
          }
          if (event.key === "Escape") controller.cancel();
        },
      }),
      h("p", { style: found.length === 0 && pending.body.includes("@") ? bad : muted }, note),
      found.length === 0 &&
        h(
          "div",
          { style: row },
          pending.members.slice(0, 8).map((member) =>
            h(
              "button",
              {
                key: member.pubkey,
                type: "button",
                className: "ui-button",
                onClick: () => {
                  const stripped = pending.addressed
                    ? pending.body.replace(new RegExp(`^\\s*@${escape(pending.addressed)}\\s*`, "i"), "")
                    : pending.body;
                  controller.editPending(`@${member.name} ${stripped.trim()}`);
                },
              },
              `@${member.name}`,
            ),
          ),
        ),
      pending.orphaned && h("p", { style: bad }, `No thread open in ${pending.channel.name}. This posts as a new message.`),
      h(
        "div",
        { style: { ...row, marginTop: "var(--space-2, 8px)" } },
        h("button", { type: "button", className: "ui-button ui-button-primary", onClick: () => void controller.publish() }, "Send"),
        h("button", { type: "button", className: "ui-button", onClick: () => controller.cancel() }, "Cancel"),
        h("span", { style: muted }, "Enter sends. Or say yes."),
      ),
    );
  }

  function LogRow({ entry }: { entry: LogEntry }) {
    return h(
      "li",
      { style: item },
      h(
        "div",
        { style: row },
        h("strong", null, entry.role === "you" ? "You" : "Buzz"),
        entry.meta && h("span", { style: muted }, entry.meta),
        entry.link &&
          h(
            "button",
            {
              type: "button",
              className: "ui-button",
              onClick: () => openTarget(entry.link!.channelId, entry.link!.messageId, entry.link!.rootId),
            },
            "Open",
          ),
      ),
      h("p", { style: { margin: "4px 0", whiteSpace: "pre-wrap", ...(entry.bad ? bad : {}) } }, entry.text),
    );
  }

  function Talk({ voice }: { voice: VoiceState }) {
    const [typed, setTyped] = useState("");
    const end = useRef(null as any);
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
      voice.watches.length > 0 &&
        h(
          "div",
          { style: { ...row, ...muted } },
          "Watching:",
          voice.watches.map((watch) =>
            h(
              "button",
              {
                key: watch.rootId,
                type: "button",
                className: "ui-button",
                title: "Stop watching",
                onClick: () => controller.unwatch(watch.rootId),
              },
              `${watch.channelName}: ${watch.label.slice(0, 40)} ✕`,
            ),
          ),
        ),
      h(
        "ol",
        { style: { listStyle: "none", padding: 0, margin: "var(--space-2, 8px) 0" }, "aria-live": "polite" },
        voice.log.length === 0 &&
          h(
            "li",
            { style: muted },
            'Try: "in ops tell build-bot the deploy is done", "how is work going in ops", or "what is in my inbox".',
          ),
        voice.log.map((entry) => h(LogRow, { key: entry.id, entry })),
      ),
      h(PendingCard, { voice }),
      h("div", { ref: end }),
      h(
        "form",
        {
          style: row,
          onSubmit: (event: any) => {
            event.preventDefault();
            controller.submitText(typed);
            setTyped("");
          },
        },
        h("input", {
          type: "text",
          "aria-label": "Type a command",
          placeholder: "Or type what you would say",
          value: typed,
          disabled: voice.busy,
          style: { flex: "1 1 240px" },
          onChange: (event: any) => setTyped(event.target.value),
        }),
        h("button", { type: "submit", className: "ui-button", disabled: voice.busy || !typed.trim() }, "Go"),
        h("button", { type: "button", className: "ui-button", onClick: () => controller.stopSpeaking() }, "Stop speaking"),
        h("button", { type: "button", className: "ui-button", onClick: () => controller.newSession() }, "New session"),
      ),
    );
  }

  function Flags({ relay }: { relay: Relay }) {
    const voice = useVoice();
    const [source, setSource] = useState(emptyFlagSource() as FlagSource);
    const [status, setStatus] = useState("Reading reactions...");
    const [mineOnly, setMineOnly] = useState(false);
    const [emoji, setEmoji] = useState(null as string | null);
    const load = useCallback(() => {
      setStatus((current: string) => current || "Refreshing...");
      loadFlags(relay)
        .then((next) => {
          setSource(next);
          setStatus("");
        })
        .catch((error) => setStatus(`Could not read reactions: ${error?.message ?? error}`));
    }, [relay]);
    useEffect(() => {
      load();
      const timer = setInterval(load, FLAG_REFRESH_MS);
      return () => clearInterval(timer);
    }, [load]);
    const channelNames = useMemo(() => new Map(relay.channels().map((c) => [c.id, c.name])), [relay, source]);
    const counts = useMemo(() => emojiCounts(source, mineOnly), [source, mineOnly]);
    const flags: Flag[] = useMemo(
      () => groupFlags(source, channelNames, { mineOnly, emoji }),
      [source, channelNames, mineOnly, emoji],
    );
    const chip = (label: string, pressed: boolean, onPick: () => void, key: string) =>
      h(
        "button",
        {
          key,
          type: "button",
          className: pressed ? "ui-button ui-button-primary" : "ui-button",
          "aria-pressed": pressed,
          onClick: onPick,
        },
        label,
      );
    return h(
      React.Fragment,
      null,
      h(
        "div",
        { style: { ...row, marginBottom: "var(--space-2, 8px)" } },
        chip("Everyone", !mineOnly, () => setMineOnly(false), "everyone"),
        chip("Mine", mineOnly, () => setMineOnly(true), "mine"),
        h("button", { type: "button", className: "ui-button", onClick: load }, "Refresh"),
      ),
      h(
        "div",
        { role: "radiogroup", "aria-label": "Emoji", style: { ...row, marginBottom: "var(--space-3, 12px)" } },
        chip(`All (${new Set(groupFlags(source, channelNames, { mineOnly, emoji: null }).map((f) => f.rootId)).size})`, emoji === null, () => setEmoji(null), "all"),
        counts.map(([e, count]: [string, number]) => chip(`${e} ${count}`, emoji === e, () => setEmoji(emoji === e ? null : e), e)),
      ),
      status && h("p", { style: muted }, status),
      !status && flags.length === 0 && h("p", { style: muted }, "No flagged threads."),
      h(
        "ul",
        { style: { listStyle: "none", padding: 0, margin: 0 } },
        flags.map((flag) =>
          h(
            "li",
            { key: flag.rootId, style: item },
            h(
              "div",
              { style: row },
              h("span", { style: { fontSize: "1.2em" } }, flag.emoji.join(" ")),
              h("strong", null, `#${flag.channelName}`),
              h("span", { style: muted }, `${flag.who.join(", ")} · ${ago(flag.at)}`),
            ),
            h("p", { style: { margin: "4px 0" } }, flag.title),
            flag.excerpt && h("p", { style: { ...muted, margin: "0 0 4px" } }, `↳ ${flag.excerpt}`),
            h(
              "div",
              { style: row },
              h(
                "button",
                { type: "button", className: "ui-button", onClick: () => openTarget(flag.channelId, flag.messageId, flag.rootId) },
                "Open in Buzz",
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "ui-button",
                  onClick: () =>
                    voice.watches.some((w) => w.rootId === flag.rootId)
                      ? controller.unwatch(flag.rootId)
                      : controller.watch({
                          rootId: flag.rootId,
                          channelId: flag.channelId,
                          channelName: flag.channelName,
                          label: flag.title,
                          since: Math.floor(Date.now() / 1000),
                        }),
                },
                voice.watches.some((w) => w.rootId === flag.rootId) ? "Following" : "Follow",
              ),
            ),
          ),
        ),
      ),
    );
  }

  function Page() {
    const connection = useConnection();
    const voice = useVoice();
    const [tab, setTab] = useState("talk");
    const relay = useMemo(() => (connection.status === "ready" ? deps.relay() : null), [connection.scope, connection.generation, connection.status]);
    useEffect(() => {
      if (connection.status === "ready") connection.session?.channels?.ensureList?.();
    }, [connection.session]);
    const tabButton = (id: string, label: string) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": tab === id,
          className: tab === id ? "ui-button ui-button-primary" : "ui-button",
          onClick: () => setTab(id),
        },
        label,
      );
    return h(
      "div",
      { style: { padding: "var(--space-panel-inset, 16px)", maxWidth: 900, height: "100%", overflowY: "auto" } },
      h("h1", null, "Buzz Voice"),
      h("div", { role: "tablist", style: { ...row, marginBottom: "var(--space-3, 12px)" } }, tabButton("talk", "Talk"), tabButton("flags", "Flags")),
      connection.status !== "ready" || !relay
        ? h(
            "p",
            { role: connection.status === "error" ? "alert" : "status" },
            connection.status === "error" ? (connection.error ?? "Could not connect.") : "Connecting to the community...",
          )
        : tab === "talk"
          ? h(Talk, { voice })
          : h(Flags, { key: `${connection.scope}:${connection.generation}`, relay }),
    );
  }

  function SettingsCard() {
    const voice = useVoice();
    const s = voice.settings;
    const field = (label: string, key: keyof typeof s, extra: Record<string, unknown> = {}) =>
      h(
        "label",
        { style: { display: "block", marginBottom: "var(--space-2, 8px)" } },
        h("div", null, label),
        h("input", {
          type: "text",
          value: String(s[key] ?? ""),
          style: { width: "100%" },
          onChange: (event: any) => controller.updateSettings({ [key]: event.target.value } as any),
          ...extra,
        }),
      );
    return h(
      "div",
      null,
      h("h3", null, "Speech to text"),
      h(
        "p",
        { style: muted },
        voice.engine
          ? `Engine ${voice.engine.engine ? "installed" : "missing"}, model ${voice.engine.model ? "installed" : "missing"}.`
          : voice.engineError || "Not checked yet.",
      ),
      field("Model folder", "modelDir"),
      field("Whisper model (small.en, base.en, tiny.en)", "whisper"),
      h(
        "div",
        { style: row },
        h(
          "button",
          { type: "button", className: "ui-button ui-button-primary", disabled: !!voice.installing, onClick: () => void controller.install() },
          voice.installing ? `${voice.installing}...` : "Install or repair",
        ),
        h("button", { type: "button", className: "ui-button", onClick: () => void controller.refreshEngine() }, "Check"),
      ),
      h("h3", null, "Language model"),
      h(
        "p",
        { style: muted },
        "Writes the message body and reads channels back. Any OpenAI-compatible endpoint, http or https, called from this Mac. Routing uses the Decisions API provider chosen in Settings when one is on. Filled from the Buzz Voice app when it is installed.",
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
          onChange: (event: any) => controller.updateSettings({ speak: event.target.checked }),
        }),
        " Read replies out loud",
      ),
      field("macOS voice (blank for the system voice)", "voice"),
    );
  }

  return { Page, SettingsCard };
}
