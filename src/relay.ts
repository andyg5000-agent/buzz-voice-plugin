import { rootOf, type Channel, type Event, type Member, type Thread } from "./types";

const KIND_MESSAGE = 9;
const KIND_REACTION = 7;
const KIND_DELETE = 5;
const CHUNK = 50;

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
  outbox?: {
    supports(kind: number): boolean;
    send(event: { kind: number; content: string; tags: string[][] }): string;
  };
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
    return [...(await this.session.read(filters))];
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

  async allReactions(channelIds: string[], limit = 1000): Promise<Event[]> {
    const filters = chunk(channelIds, CHUNK).map((ids) => ({ kinds: [KIND_REACTION], "#h": ids, limit }));
    return filters.length ? this.query(filters) : [];
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
