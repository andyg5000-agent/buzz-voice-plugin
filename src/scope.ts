import type { Channel, Thread } from "./types";
export interface ScopeThread {
  rootId: string;
  channelId: string;
  channelName: string;
  label: string;
  who: string[];
  lastAt: number;
}

export interface Scope {
  channel: Channel | null;
  threads: ScopeThread[];
  focus: ScopeThread | null;
}

export function emptyScope(): Scope {
  return { channel: null, threads: [], focus: null };
}

export function describeThread(thread: Thread, names: Map<string, string>): ScopeThread {
  const root = thread.messages[0];
  const label = (root?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 70);
  const who = [
    ...new Set(thread.messages.map((m) => names.get(m.pubkey) ?? m.pubkey.slice(0, 8))),
  ].slice(0, 4);
  return {
    rootId: thread.rootId,
    channelId: "",
    channelName: "",
    label: label || thread.rootId.slice(0, 8),
    who,
    lastAt: thread.lastAt,
  };
}
export function setThreads(
  scope: Scope,
  channel: Channel,
  threads: ScopeThread[],
  focus: ScopeThread | null,
): Scope {
  const owned = threads.map((t) => ({ ...t, channelId: channel.id, channelName: channel.name }));
  const picked = focus
    ? (owned.find((t) => t.rootId === focus.rootId) ?? null)
    : null;
  return { channel, threads: owned, focus: picked ?? owned[owned.length - 1] ?? null };
}
export function rememberPost(scope: Scope, channel: Channel, thread: ScopeThread): Scope {
  const owned = { ...thread, channelId: channel.id, channelName: channel.name };
  const same = scope.channel?.id === channel.id;
  const rest = (same ? scope.threads : []).filter((t) => t.rootId !== owned.rootId);
  return { channel, threads: [...rest, owned], focus: owned };
}
export function setItems(
  channel: Channel | null,
  threads: ScopeThread[],
  focus: ScopeThread | null,
): Scope {
  return { channel, threads, focus };
}

export function threadByRef(scope: Scope, ref: number | null): ScopeThread | null {
  if (ref === null) return null;
  return scope.threads[ref - 1] ?? null;
}
export function resolveThread(
  scope: Scope,
  channel: Channel,
  ref: number | null,
): ScopeThread | null {
  if (ref !== null) {
    const picked = threadByRef(scope, ref);
    return picked && picked.channelId === channel.id ? picked : null;
  }
  return scope.focus && scope.focus.channelId === channel.id ? scope.focus : null;
}

export function scopeLabel(scope: Scope): string {
  if (!scope.focus) return scope.channel?.name ?? "";
  const index = scope.threads.findIndex((t) => t.rootId === scope.focus?.rootId);
  const number = index >= 0 ? `${index + 1}` : "?";
  const where = scope.focus.channelName || scope.channel?.name || "";
  return `${where} · thread ${number}: ${scope.focus.label}`;
}
