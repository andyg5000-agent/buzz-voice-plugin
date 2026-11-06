// Prebuilt API v1 module. Typed chat with the relay and find-by-emoji; voice comes later.
export const inject = ["react", "pages", "relay", "navigation"];

export const STATES = [
  { key: "working", emoji: "\u{1F504}", label: "Working" },
  { key: "stalled", emoji: "⛔", label: "Stalled" },
  { key: "done", emoji: "✅", label: "Done" },
  { key: "needs-input", emoji: "\u{1F440}", label: "Needs input" },
];
const EMOJI_STATE = new Map(STATES.map((state) => [state.emoji, state.key]));
const MAX_ROOTS = 100;
const CHUNK = 50;
const EMPTY_VIEW = Object.freeze({ status: "idle", events: [] });
const EMPTY_THREAD = Object.freeze({ status: "idle", root: undefined, replies: [] });

export function stateOf(content) {
  return EMOJI_STATE.get(String(content ?? "").replace(/\uFE0F/g, "").trim());
}

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function lastE(event) {
  return event.tags.filter((tag) => tag[0] === "e" && tag[1]).at(-1)?.[1];
}

export function rootOf(event) {
  const marked = event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1];
  return marked ?? event.tags.find((tag) => tag[0] === "e" && tag[1])?.[1] ?? event.id;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Latest reaction per author per target wins; then the newest state emoji
// among those latest reactions is the target's state. Same rules as state.ts.
export function foldStates(events) {
  const deleted = new Map();
  for (const event of events) {
    if (event.kind !== 5) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "e" || !tag[1]) continue;
      const by = deleted.get(tag[1]) ?? new Set();
      by.add(event.pubkey);
      deleted.set(tag[1], by);
    }
  }
  const latest = new Map();
  for (const reaction of events) {
    if (reaction.kind !== 7 || reaction.error) continue;
    if (deleted.get(reaction.id)?.has(reaction.pubkey)) continue;
    const target = lastE(reaction);
    if (!target) continue;
    const key = `${target}:${reaction.pubkey}`;
    const seen = latest.get(key);
    if (!seen || seen.created_at < reaction.created_at) latest.set(key, reaction);
  }
  const byTarget = new Map();
  for (const reaction of latest.values()) {
    const state = stateOf(reaction.content);
    if (!state) continue;
    const target = lastE(reaction);
    const entry = byTarget.get(target) ?? {
      target,
      channelId: tagValue(reaction, "h"),
      reactions: [],
    };
    entry.reactions.push(reaction);
    if (!entry.reaction || entry.reaction.created_at < reaction.created_at) {
      entry.reaction = reaction;
      entry.state = state;
    }
    byTarget.set(target, entry);
  }
  for (const entry of byTarget.values()) {
    entry.who = entry.reactions
      .filter((reaction) => stateOf(reaction.content) === entry.state)
      .sort((a, b) => b.created_at - a.created_at)
      .map((reaction) => reaction.pubkey);
  }
  return byTarget;
}

export function canon(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/(.)\1+/g, "$1");
}

// "#ops apply updates" routes to the channel named ops. Exact canonical name
// first, then the longest name that starts with what was typed.
export function routeCommand(text, channels) {
  const match = /^#(\S+)\s+([\s\S]+)$/.exec(text.trim());
  if (!match) return { body: text.trim() };
  const wanted = canon(match[1]);
  const exact = channels.find((channel) => canon(channel.name) === wanted);
  const prefix = channels
    .filter((channel) => wanted && canon(channel.name).startsWith(wanted))
    .sort((a, b) => a.name.length - b.name.length)[0];
  const channel = exact ?? prefix;
  if (!channel) return { error: `No channel matches #${match[1]}` };
  return { channel, body: match[2].trim() };
}

function snippet(text, size = 140) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat;
}

function ago(seconds) {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function scopeOf(connection) {
  const at = connection.scope?.lastIndexOf(":") ?? -1;
  if (at < 0 || connection.scope.slice(at + 1) !== connection.viewer) return undefined;
  return { communityOrigin: connection.scope.slice(0, at), viewer: connection.viewer };
}

function storage() {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function createVoicePage(React, relay, navigator) {
  const h = React.createElement;
  const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React;

  function useObserved(session, key, build) {
    const [snapshot, setSnapshot] = useState(EMPTY_VIEW);
    useEffect(() => {
      const filters = build();
      if (!filters || !filters.length) {
        setSnapshot(EMPTY_VIEW);
        return undefined;
      }
      let view;
      try {
        view = session.observe(filters);
      } catch (error) {
        setSnapshot({ status: "error", events: [], error: String(error) });
        return undefined;
      }
      const update = () => setSnapshot(view.snapshot());
      const unsubscribe = view.subscribe(update);
      update();
      void view.refresh();
      return () => {
        unsubscribe();
        view.dispose();
      };
    }, [session, key]);
    return snapshot;
  }

  function useThread(session, channelId, rootId) {
    const [snapshot, setSnapshot] = useState(EMPTY_THREAD);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if (!channelId || !rootId) {
        setSnapshot(EMPTY_THREAD);
        return undefined;
      }
      let view;
      try {
        view = session.thread(channelId, rootId);
      } catch (error) {
        setSnapshot({ ...EMPTY_THREAD, status: "error", error: String(error) });
        return undefined;
      }
      const update = () => setSnapshot(view.snapshot());
      const unsubscribe = view.subscribe(update);
      update();
      void view.refresh();
      return () => {
        unsubscribe();
        view.dispose();
      };
    }, [session, channelId, rootId, attempt]);
    return [snapshot, () => setAttempt((n) => n + 1)];
  }

  function useNames(session, pubkeys) {
    const profiles = useSyncExternalStore(
      session.profiles.subscribe,
      session.profiles.snapshot,
      session.profiles.snapshot,
    );
    const key = [...new Set(pubkeys)].sort().join(",");
    useEffect(() => {
      const missing = key ? key.split(",").filter((id) => !profiles.has(id)) : [];
      if (missing.length) void session.profiles.ensure(missing).catch(() => {});
    }, [session, key]);
    return useCallback(
      (pubkey) => profiles.get(pubkey)?.name || `${String(pubkey).slice(0, 8)}…`,
      [profiles],
    );
  }

  const card = { padding: "var(--space-panel-inset, 16px)", marginBottom: "var(--space-4, 16px)" };
  const row = { display: "flex", gap: "var(--space-2, 8px)", alignItems: "center", flexWrap: "wrap" };
  const muted = { opacity: 0.7, fontSize: "0.9em" };
  const list = { listStyle: "none", padding: 0, margin: "var(--space-2, 8px) 0 0" };
  const item = { padding: "var(--space-2, 8px) 0", borderTop: "1px solid var(--color-border, rgba(127,127,127,0.25))" };

  function FindByEmoji({ session, channels, scope, onReply }) {
    const [selected, setSelected] = useState("working");
    const [notice, setNotice] = useState("");
    const channelIds = useMemo(() => channels.map((channel) => channel.id).sort(), [channels]);
    const reactions = useObserved(session, channelIds.join(","), () =>
      chunk(channelIds, CHUNK).flatMap((ids) => [
        { kinds: [7], "#h": ids, limit: 500 },
        { kinds: [5], "#h": ids, limit: 200 },
      ]),
    );
    const states = useMemo(() => foldStates(reactions.events), [reactions.events]);
    const counts = useMemo(() => {
      const out = {};
      for (const entry of states.values()) out[entry.state] = (out[entry.state] ?? 0) + 1;
      return out;
    }, [states]);
    const matching = useMemo(
      () =>
        [...states.values()]
          .filter((entry) => entry.state === selected)
          .sort((a, b) => b.reaction.created_at - a.reaction.created_at)
          .slice(0, MAX_ROOTS),
      [states, selected],
    );
    const targetKey = matching.map((entry) => entry.target).sort().join(",");
    const roots = useObserved(session, targetKey, () =>
      chunk(targetKey ? targetKey.split(",") : [], CHUNK).map((ids) => ({
        kinds: [9, 40002],
        ids,
        limit: ids.length,
      })),
    );
    const byId = useMemo(() => new Map(roots.events.map((event) => [event.id, event])), [roots.events]);
    const names = useNames(session, matching.flatMap((entry) => entry.who));
    const channelName = (id) => channels.find((channel) => channel.id === id)?.name ?? "unknown channel";
    const open = (entry, event) => {
      const channelId = entry.channelId;
      if (!channelId || !scope) return;
      setNotice("");
      void navigator
        .open({
          version: 1,
          kind: "conversation",
          scope,
          channelId,
          messageId: entry.target,
          threadRootId: event ? rootOf(event) : entry.target,
        })
        .then((result) => {
          if (result?.status === "failed") setNotice("That thread could not be opened.");
        });
    };
    return h(
      "section",
      { className: "ui-card", style: card, "aria-labelledby": "buzz-voice-find" },
      h("h2", { id: "buzz-voice-find" }, "Find by emoji"),
      h(
        "div",
        { role: "radiogroup", "aria-label": "Thread state", style: row },
        STATES.map((state) =>
          h(
            "button",
            {
              key: state.key,
              type: "button",
              role: "radio",
              "aria-checked": selected === state.key,
              className: selected === state.key ? "ui-button ui-button-primary" : "ui-button",
              onClick: () => setSelected(state.key),
            },
            `${state.emoji} ${state.label} (${counts[state.key] ?? 0})`,
          ),
        ),
      ),
      reactions.status === "error" &&
        h("p", { role: "alert" }, `Could not read reactions: ${reactions.error}`),
      notice && h("p", { role: "alert" }, notice),
      matching.length === 0
        ? h(
            "p",
            { style: muted },
            reactions.status === "loading" || reactions.status === "idle"
              ? "Reading reactions…"
              : "No threads in this state.",
          )
        : h(
            "ul",
            { style: list },
            matching.map((entry) => {
              const event = byId.get(entry.target);
              return h(
                "li",
                { key: entry.target, style: item },
                h(
                  "div",
                  { style: row },
                  h("strong", null, `#${channelName(entry.channelId)}`),
                  h(
                    "span",
                    { style: muted },
                    `${entry.who.map(names).join(", ")} · ${ago(entry.reaction.created_at)}`,
                  ),
                ),
                h(
                  "p",
                  { style: { margin: "4px 0" } },
                  event
                    ? snippet(event.content)
                    : roots.status === "loading"
                      ? "Loading message…"
                      : "Message not loaded.",
                ),
                h(
                  "div",
                  { style: row },
                  h(
                    "button",
                    { type: "button", className: "ui-button", onClick: () => open(entry, event) },
                    "Open thread",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "ui-button",
                      onClick: () =>
                        onReply(entry.channelId, event ? rootOf(event) : entry.target),
                    },
                    "Reply here",
                  ),
                ),
              );
            }),
          ),
    );
  }

  function ThreadReplies({ session, channelId, rootId, names }) {
    const [thread, retry] = useThread(session, channelId, rootId);
    const rows = [thread.root, ...(thread.replies ?? [])].filter(Boolean);
    useNames(session, rows.map((message) => message.authorId));
    return h(
      "div",
      { "aria-live": "polite", "aria-label": "Thread replies" },
      thread.status === "error" &&
        h(
          "p",
          { role: "alert" },
          `Thread unavailable: ${thread.error ?? "unknown error"} `,
          h("button", { type: "button", className: "ui-button", onClick: retry }, "Retry"),
        ),
      rows.length === 0 && thread.status !== "error" && h("p", { style: muted }, "Loading thread…"),
      h(
        "ol",
        { style: list },
        rows.map((message, index) =>
          h(
            "li",
            { key: message.id, style: item },
            h(
              "div",
              { style: row },
              h("strong", null, names(message.authorId)),
              h(
                "span",
                { style: muted },
                `${index === 0 ? "root · " : ""}${ago(message.createdAt)}${
                  message.delivery && message.delivery !== "seen" ? ` · ${message.delivery}` : ""
                }`,
              ),
            ),
            h("p", { style: { margin: "4px 0", whiteSpace: "pre-wrap" } }, message.content),
          ),
        ),
      ),
    );
  }

  function Chat({ session, channels, names, storageKey, target }) {
    const writable = useMemo(
      () => channels.filter((channel) => !channel.readOnly && !channel.archived && !channel.pending),
      [channels],
    );
    const [channelId, setChannelId] = useState(() => storage()?.getItem(`${storageKey}:channel`) ?? "");
    const [rootId, setRootId] = useState("");
    const [text, setText] = useState("");
    const [error, setError] = useState("");
    useEffect(() => {
      if (!writable.length || writable.some((channel) => channel.id === channelId)) return;
      setChannelId(writable[0].id);
      setRootId("");
    }, [writable, channelId]);
    useEffect(() => {
      if (channelId) storage()?.setItem(`${storageKey}:channel`, channelId);
    }, [storageKey, channelId]);
    useEffect(() => {
      if (!target) return;
      setChannelId(target.channelId);
      setRootId(target.rootId);
    }, [target]);
    const subscribeWindow = useCallback(
      (listener) => (channelId ? session.channels.subscribeWindow(channelId, listener) : () => {}),
      [session, channelId],
    );
    const readWindow = useCallback(
      () => (channelId ? session.channels.window(channelId) : undefined),
      [session, channelId],
    );
    const recent = useSyncExternalStore(subscribeWindow, readWindow, readWindow);
    useEffect(() => {
      if (channelId) session.channels.ensure(channelId);
    }, [session, channelId]);
    const threads = useMemo(() => {
      const rows = (recent?.rows ?? []).filter((message) => !message.threadRootId);
      return rows.slice(-20).reverse();
    }, [recent]);
    useNames(session, threads.map((message) => message.authorId));
    const submit = (event) => {
      event?.preventDefault?.();
      setError("");
      const routed = routeCommand(text, writable);
      if (routed.error) return setError(routed.error);
      if (!routed.body) return setError("Type a message first.");
      const toChannel = routed.channel?.id ?? channelId;
      const toRoot = routed.channel && routed.channel.id !== channelId ? "" : rootId;
      if (!toChannel) return setError("Pick a channel first.");
      try {
        const id = toRoot
          ? session.messages.reply(toChannel, toRoot, routed.body)
          : session.messages.send(toChannel, routed.body);
        setChannelId(toChannel);
        setRootId(toRoot || id);
        setText("");
      } catch (reason) {
        setError(String(reason?.message ?? reason));
      }
    };
    const options = threads.some((message) => message.id === rootId) || !rootId
      ? threads
      : [{ id: rootId, content: "Current thread", authorId: "" }, ...threads];
    return h(
      "section",
      { className: "ui-card", style: card, "aria-labelledby": "buzz-voice-chat" },
      h("h2", { id: "buzz-voice-chat" }, "Chat with relay"),
      h(
        "form",
        { onSubmit: submit },
        h(
          "div",
          { style: row },
          h(
            "label",
            null,
            "Channel ",
            h(
              "select",
              {
                value: channelId,
                onChange: (event) => {
                  setChannelId(event.target.value);
                  setRootId("");
                },
              },
              writable.map((channel) => h("option", { key: channel.id, value: channel.id }, `#${channel.name}`)),
            ),
          ),
          h(
            "label",
            null,
            "Thread ",
            h(
              "select",
              { value: rootId, onChange: (event) => setRootId(event.target.value) },
              h("option", { value: "" }, "New top-level message"),
              options.map((message) =>
                h(
                  "option",
                  { key: message.id, value: message.id },
                  `${message.authorId ? `${names(message.authorId)}: ` : ""}${snippet(message.content, 60)}`,
                ),
              ),
            ),
          ),
        ),
        h("textarea", {
          "aria-label": "Message",
          value: text,
          rows: 3,
          placeholder: "Type a message. Start with #channel to route it there.",
          style: { display: "block", width: "100%", marginTop: "var(--space-2, 8px)" },
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
          },
        }),
        h(
          "div",
          { style: { ...row, marginTop: "var(--space-2, 8px)" } },
          h(
            "button",
            { type: "submit", className: "ui-button ui-button-primary" },
            rootId ? "Reply" : "Post",
          ),
          h("span", { style: muted }, "Cmd/Ctrl+Enter sends"),
        ),
        error && h("p", { role: "alert" }, error),
      ),
      rootId
        ? h(ThreadReplies, { key: `${channelId}:${rootId}`, session, channelId, rootId, names })
        : h("p", { style: muted }, "Pick a thread or post a message to follow its replies here."),
    );
  }

  function Community({ session, connection }) {
    useEffect(() => session.channels.ensureList(), [session]);
    const listing = useSyncExternalStore(
      session.channels.subscribeList,
      session.channels.list,
      session.channels.list,
    );
    const channels = useMemo(
      () => listing.channels.filter((channel) => !channel.huddle && channel.channelType !== "system"),
      [listing],
    );
    const names = useNames(session, []);
    const scope = useMemo(() => scopeOf(connection), [connection.scope, connection.viewer]);
    const [target, setTarget] = useState(undefined);
    const storageKey = `blueoi.buzz-voice:${connection.scope ?? "none"}`;
    return h(
      React.Fragment,
      null,
      listing.status === "error" && h("p", { role: "alert" }, listing.error ?? "Channels unavailable."),
      h(FindByEmoji, {
        session,
        channels,
        scope,
        onReply: (channelId, rootId) => setTarget({ channelId, rootId }),
      }),
      h(Chat, { session, channels, names, storageKey, target }),
    );
  }

  return function BuzzVoicePage() {
    const connection = useSyncExternalStore(relay.subscribe, relay.snapshot, relay.snapshot);
    return h(
      "div",
      { style: { padding: "var(--space-panel-inset, 16px)", maxWidth: 900 } },
      h("h1", null, "Buzz Voice"),
      connection.status === "ready"
        ? h(Community, {
            key: `${connection.scope}:${connection.generation}`,
            session: connection.session,
            connection,
          })
        : h(
            "p",
            { role: connection.status === "error" ? "alert" : "status" },
            connection.status === "error"
              ? (connection.error ?? "Could not connect.")
              : "Connecting to the community…",
          ),
    );
  };
}

export function apply(ctx) {
  ctx.pages.register({
    id: "main",
    title: "Buzz Voice",
    primary: true,
    component: createVoicePage(ctx.react, ctx.relay, ctx.navigation),
  });
}
