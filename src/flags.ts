import type { Relay } from "./relay";
import { rootOf, tagValue, type Event } from "./types";

export interface Flag {
  rootId: string;
  messageId: string;
  channelId: string;
  channelName: string;
  title: string;
  excerpt: string;
  emoji: string[];
  who: string[];
  at: number;
}

export interface FlagSource {
  reactions: Event[];
  messages: Map<string, Event>;
  names: Map<string, string>;
  mine: string;
}

export interface FlagFilter {
  mineOnly: boolean;
  emoji: string | null;
}

const REACTION_LIMIT = 1000;

function targetOf(reaction: Event): string | undefined {
  return reaction.tags.filter((t) => t[0] === "e" && t[1]).at(-1)?.[1];
}

function emojiOf(reaction: Event): string {
  return reaction.content.replace(/️/g, "").trim();
}

function line(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_~`]+/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function emptyFlagSource(): FlagSource {
  return { reactions: [], messages: new Map(), names: new Map(), mine: "" };
}

export async function loadFlags(relay: Relay): Promise<FlagSource> {
  const channelIds = relay.channels().map((c) => c.id);
  const all = await relay.allReactions(channelIds, REACTION_LIMIT);
  const usable = all.filter((event) => emojiOf(event) && emojiOf(event) !== "-" && targetOf(event));
  const gone = await relay.deleted(usable.map((event) => event.id));
  const live = usable.filter((event) => !gone.has(event.id));

  const messages = new Map<string, Event>();
  for (const event of await relay.byIds(live.map((r) => targetOf(r) as string))) messages.set(event.id, event);
  const roots = [...messages.values()].map(rootOf).filter((id) => !messages.has(id));
  for (const event of await relay.byIds(roots)) messages.set(event.id, event);

  const reactions = live.filter((event) => messages.has(targetOf(event) as string));
  const names = await relay.profiles([...new Set(reactions.map((event) => event.pubkey))]);
  return { reactions, messages, names, mine: relay.pubkey };
}

function selected(source: FlagSource, filter: FlagFilter): Event[] {
  return source.reactions.filter(
    (event) => (!filter.mineOnly || event.pubkey === source.mine) && (!filter.emoji || emojiOf(event) === filter.emoji),
  );
}

export function emojiCounts(source: FlagSource, mineOnly: boolean): [string, number][] {
  const threads = new Map<string, Set<string>>();
  for (const event of selected(source, { mineOnly, emoji: null })) {
    const target = source.messages.get(targetOf(event) as string);
    if (!target) continue;
    const emoji = emojiOf(event);
    const seen = threads.get(emoji) ?? new Set<string>();
    seen.add(rootOf(target));
    threads.set(emoji, seen);
  }
  return [...threads.entries()]
    .map(([emoji, seen]) => [emoji, seen.size] as [string, number])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function groupFlags(source: FlagSource, channelNames: Map<string, string>, filter: FlagFilter): Flag[] {
  const byRoot = new Map<string, Flag>();
  for (const event of selected(source, filter)) {
    const target = source.messages.get(targetOf(event) as string);
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
        at: 0,
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
