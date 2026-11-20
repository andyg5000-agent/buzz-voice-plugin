import { rootOf, type Channel, type Event, type Member, type Thread } from "./types";

const KIND_MESSAGE = 9;
const KIND_REACTION = 7;
const KIND_DELETE = 5;
const KIND_EDIT = 40003;
const CHUNK = 50;
const READ_LIMIT = 500;

export interface Session {
  read(filters: unknown[], options?: { signal?: AbortSignal }): Promise<Event[]>;
  observe(filters: unknown[]): {
    snapshot(): { status: string; events: Event[]; error?: string };
    subscribe(listener: () => void): () => void;
    refresh(): Promise<void>;
    dispose(): void;
  };
  channels: {
    ensureList(): void;
    list(): { status: string; channels: any[]; error?: string };
    subscribeList(listener: () => void): () => void;
  };
  profiles: {
    snapshot(): Map<string, { name: string }>;
    subscribe(listener: () => void): () => void;
    ensure(pubkeys: string[], priority?: string): Promise<unknown>;
  };
  messages: {
    send(channelId: string, text: string): string;
    reply(channelId: string, rootId: string, text: string): string;
  };
  canvas?: {
    available: boolean;
    read(channel: string): Promise<CanvasHead | null | undefined>;
    save(channel: string, content: string, expected: string | undefined, options?: { preserveApproval: boolean }): Promise<CanvasHead>;
  };
  outbox?: {
    supports(kind: number): boolean;
    send(event: { kind: number; content: string; tags: string[][] }): string;
  };
}

export interface ThreadView {
  channelId: string;
  rootId: string;
  messages: (Event & { edited: boolean })[];
  reactions: Map<string, Map<string, string[]>>;
  names: Map<string, string>;
  at: number;
}

export interface CanvasHead {
  id: string;
  content: string;
  created_at: number;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function byTime(a: Event, b: Event): number {
  return a.created_at - b.created_at;
}

export class Relay {
  constructor(
    readonly session: Session,
    readonly pubkey: string,
  ) {}

  channels(): Channel[] {
    return this.session.channels
      .list()
      .channels.filter(
        (c: any) =>
          !c.huddle &&
          !c.archived &&
          c.channelType !== "system" &&
          c.channelType !== "dm" &&
          c.channelType !== "solo",
      )
      .map((c: any) => ({ id: c.id, name: c.name, description: c.description, members: c.members, readOnly: c.readOnly }));
  }

  async query(filters: unknown[]): Promise<Event[]> {
    const bounded = filters.map((filter: any) => ({ ...filter, limit: Math.max(1, Math.min(READ_LIMIT, filter.limit ?? READ_LIMIT)) }));
    return [...(await this.session.read(bounded))];
  }

  async byIds(ids: string[]): Promise<Event[]> {
    const unique = [...new Set(ids)];
    const found: Event[] = [];
    for (const batch of chunk(unique, CHUNK)) {
      found.push(...(await this.query([{ ids: batch, limit: batch.length }])));
    }
    return found;
  }

  async messagesInThread(channelId: string, rootId: string): Promise<Event[]> {
    const events = await this.query([{ kinds: [KIND_MESSAGE], "#h": [channelId], "#e": [rootId], limit: 200 }]);
    return events.sort(byTime);
  }

  /** A thread as Buzz shows it: root first, latest edits applied, deletions dropped, reactions counted. */
  async fullThread(channelId: string, rootId: string): Promise<ThreadView> {
    const [replies, roots] = await Promise.all([
      this.query([{ kinds: [KIND_MESSAGE], "#h": [channelId], "#e": [rootId], limit: READ_LIMIT }]),
      this.byIds([rootId]),
    ]);
    const messages = [...roots, ...replies.filter((e) => e.id !== rootId)].sort(byTime);
    const ids = messages.map((e) => e.id);
    const related: Event[] = [];
    for (const batch of chunk(ids, CHUNK)) {
      related.push(...(await this.query([{ kinds: [KIND_EDIT, KIND_REACTION], "#e": batch, limit: READ_LIMIT }])));
    }
    const gone = await this.deleted([...ids, ...related.map((e) => e.id)]);
    const edits = new Map<string, Event>();
    const reactions = new Map<string, Map<string, string[]>>();
    for (const event of related.sort(byTime)) {
      if (gone.has(event.id)) continue;
      const target = event.tags.filter((t) => t[0] === "e" && t[1]).at(-1)?.[1];
      if (!target) continue;
      if (event.kind === KIND_EDIT) {
        const original = messages.find((m) => m.id === target);
        if (original && original.pubkey === event.pubkey) edits.set(target, event);
        continue;
      }
      const emoji = event.content.replace(/\uFE0F/g, "").trim();
      if (!emoji || emoji === "-") continue;
      const byEmoji = reactions.get(target) ?? new Map<string, string[]>();
      const who = byEmoji.get(emoji) ?? [];
      if (!who.includes(event.pubkey)) who.push(event.pubkey);
      byEmoji.set(emoji, who);
      reactions.set(target, byEmoji);
    }
    const shown = messages
      .filter((e) => !gone.has(e.id))
      .map((e) => ({ ...e, content: edits.get(e.id)?.content ?? e.content, edited: edits.has(e.id) }));
    const names = await this.profiles(shown.map((e) => e.pubkey));
    return { channelId, rootId, messages: shown, reactions, names, at: Date.now() };
  }

  async threads(channelId: string, limit = 80): Promise<Thread[]> {
    const events = (await this.query([{ kinds: [KIND_MESSAGE], "#h": [channelId], limit }])).sort(byTime);
    const byRoot = new Map<string, Event[]>();
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
    return [...byRoot.entries()]
      .map(([rootId, messages]) => ({ rootId, messages, lastAt: messages[messages.length - 1].created_at }))
      .sort((a, b) => a.lastAt - b.lastAt);
  }

  async repliesIn(rootIds: string[], since: number): Promise<Event[]> {
    if (rootIds.length === 0) return [];
    const events = await this.query([{ kinds: [KIND_MESSAGE], "#e": rootIds, since, limit: 200 }]);
    return events.filter((e) => e.created_at >= since).sort(byTime);
  }

  async mentions(since: number): Promise<Event[]> {
    const events = await this.query([{ kinds: [KIND_MESSAGE], "#p": [this.pubkey], since, limit: 200 }]);
    return events.filter((e) => e.pubkey !== this.pubkey).sort(byTime);
  }

  async mineIn(rootIds: string[]): Promise<Event[]> {
    if (rootIds.length === 0) return [];
    return this.query([{ kinds: [KIND_MESSAGE], authors: [this.pubkey], "#e": rootIds, limit: 200 }]);
  }

  async allReactions(channelIds: string[], total = 1000): Promise<Event[]> {
    const pages = await Promise.all(
      chunk(channelIds, CHUNK).map(async (ids) => {
        const found = new Map<string, Event>();
        let until: number | undefined;
        while (found.size < total) {
          const page = await this.query([{ kinds: [KIND_REACTION], "#h": ids, limit: READ_LIMIT, ...(until ? { until } : {}) }]);
          const before = found.size;
          for (const event of page) found.set(event.id, event);
          if (page.length < READ_LIMIT || found.size === before) break;
          until = Math.min(...page.map((e) => e.created_at));
        }
        return [...found.values()];
      }),
    );
    return pages.flat();
  }

  async deleted(ids: string[]): Promise<Set<string>> {
    const gone = new Set<string>();
    for (const batch of chunk(ids, CHUNK)) {
      const events = await this.query([{ kinds: [KIND_DELETE], "#e": batch, limit: batch.length * 2 }]);
      for (const event of events) {
        for (const tag of event.tags) if (tag[0] === "e" && tag[1]) gone.add(tag[1]);
      }
    }
    return gone;
  }

  async profiles(pubkeys: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(pubkeys)];
    if (unique.length) await this.session.profiles.ensure(unique).catch(() => undefined);
    const snapshot = this.session.profiles.snapshot();
    const names = new Map<string, string>();
    for (const pubkey of unique) {
      const name = snapshot.get(pubkey)?.name;
      if (name) names.set(pubkey, name);
    }
    return names;
  }

  async members(channel: Channel): Promise<Member[]> {
    let roster = [...(channel.members ?? [])];
    if (roster.length === 0) {
      const lists = await this.query([{ kinds: [39002], "#d": [channel.id], limit: 5 }]).catch(() => []);
      const newest = lists.sort(byTime).at(-1);
      roster = newest ? newest.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]) : [];
    }
    const ids = [...new Set(roster)].filter((id) => id !== this.pubkey);
    const names = await this.profiles(ids);
    return ids.map((pubkey) => ({ pubkey, name: names.get(pubkey) ?? "" })).filter((m) => m.name);
  }

  async readCanvas(channelId: string): Promise<CanvasHead | null> {
    const canvas = this.session.canvas;
    if (!canvas) throw new Error("This Buzz build has no Canvas.");
    return (await canvas.read(channelId)) ?? null;
  }

  /** Applies `edit` to the latest Canvas, retrying once if someone saved in between. */
  async editCanvas(channelId: string, edit: (content: string) => string): Promise<CanvasHead> {
    const canvas = this.session.canvas;
    if (!canvas?.available) throw new Error("Canvas writing is unavailable here.");
    for (let attempt = 0; ; attempt += 1) {
      const head = (await canvas.read(channelId)) ?? null;
      const next = edit(head?.content ?? "");
      const wait = ((head?.created_at ?? 0) + 1) * 1000 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1000)));
      try {
        return await canvas.save(channelId, next, head?.id, { preserveApproval: true });
      } catch (error) {
        if (attempt > 0 || !/Canvas changed/.test(String((error as Error)?.message))) throw error;
      }
    }
  }

  canReact(): boolean {
    const outbox = this.session.outbox;
    return !!outbox?.supports(KIND_REACTION) && outbox.supports(KIND_DELETE);
  }

  react(target: Event, emoji: string): Event {
    const outbox = this.session.outbox;
    const channelId = target.tags.find((t) => t[0] === "h")?.[1];
    if (!outbox?.supports(KIND_REACTION) || !channelId) throw new Error("This Buzz connection cannot add reactions.");
    const tags = [
      ["h", channelId],
      ["e", target.id],
      ["p", target.pubkey],
    ];
    const id = outbox.send({ kind: KIND_REACTION, content: emoji, tags });
    return { id, pubkey: this.pubkey, created_at: Math.floor(Date.now() / 1000), kind: KIND_REACTION, content: emoji, tags };
  }

  unreact(reactions: Event[], channelId: string): void {
    const outbox = this.session.outbox;
    if (!outbox?.supports(KIND_DELETE)) throw new Error("This Buzz connection cannot remove reactions.");
    for (const reaction of reactions) {
      if (reaction.pubkey !== this.pubkey) continue;
      outbox.send({ kind: KIND_DELETE, content: "", tags: [["h", channelId], ["e", reaction.id], ["k", String(KIND_REACTION)]] });
    }
  }

  postMessage(options: { channelId: string; content: string; replyTo?: string; mentions?: string[] }): {
    id: string;
    created_at: number;
  } {
    const created_at = Math.floor(Date.now() / 1000);
    const outbox = this.session.outbox;
    if (options.mentions?.length && outbox?.supports(KIND_MESSAGE)) {
      const tags: string[][] = [["h", options.channelId]];
      if (options.replyTo) tags.push(["e", options.replyTo, "", "reply"]);
      for (const p of options.mentions) tags.push(["p", p]);
      return { id: outbox.send({ kind: KIND_MESSAGE, content: options.content, tags }), created_at };
    }
    const id = options.replyTo
      ? this.session.messages.reply(options.channelId, options.replyTo, options.content)
      : this.session.messages.send(options.channelId, options.content);
    return { id, created_at };
  }
}
