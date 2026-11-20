import { fromMarkdown } from "mdast-util-from-markdown";
import type { ListItem } from "mdast";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) if ((top >> i) & 1) chk ^= gen[i];
  }
  return chk;
}

function npub(hex: string): string {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < hex.length; i += 2) {
    acc = ((acc << 8) | parseInt(hex.slice(i, i + 2), 16)) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const prefix = "npub";
  const expanded = [...[...prefix].map((c) => c.charCodeAt(0) >> 5), 0, ...[...prefix].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return `${prefix}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

function profileTarget(pubkey: string): string | undefined {
  return /^[a-f0-9]{64}$/i.test(pubkey) ? `nostr:${npub(pubkey.toLowerCase())}` : undefined;
}

function profileKey(target: string): string | undefined {
  const match = /^nostr:(npub1[023456789acdefghjklmnpqrstuvwxyz]{58})$/.exec(target);
  if (!match) return undefined;
  const words = [...match[1].slice(5, -6)].map((c) => CHARSET.indexOf(c));
  let acc = 0;
  let bits = 0;
  let hex = "";
  for (const word of words) {
    acc = ((acc << 5) | word) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((acc >> bits) & 255).toString(16).padStart(2, "0");
    }
  }
  return hex.length === 64 && profileTarget(hex) === target ? hex : undefined;
}

export type Assignee = { pubkey: string; name: string };
export type Status = "todo" | "doing" | "done";
/** `[/]` is the common Markdown convention for an in-progress task. */
const marks = { todo: " ", doing: "/", done: "x" } as const;
export type Todo = {
  offset: number;
  label: string;
  parents: string[];
  status: Status;
  end: number;
  namedAssignee?: { name: string; start: number };
  assignee?: (Assignee & { start: number }) | undefined;
};
const assignment = " · Assignee: ";
/** Source offsets let checkbox edits leave every other byte of the Canvas alone. */
export function readTodos(content: string) {
  const nodes = fromMarkdown(content).children;
  const headings = nodes.filter(
    (node) =>
      node.type === "heading" &&
      node.depth === 2 &&
      node.children.length === 1 &&
      node.children[0]?.type === "text" &&
      node.children[0].value === "Todos",
  );
  if (headings.length > 1)
    throw new Error(
      "Canvas has more than one Todos section. Keep one ## Todos heading in Canvas before editing here.",
    );
  const heading = headings[0];
  const start = heading?.position?.end.offset;
  const following = heading ? nodes.slice(nodes.indexOf(heading) + 1) : [];
  const boundary = following.findIndex(
    (node) => node.type === "heading" && node.depth <= 2,
  );
  const section = boundary < 0 ? following : following.slice(0, boundary);
  const items: Todo[] = [];
  function visit(children: ListItem[], parents: string[]) {
    for (const item of children) {
      const before = items.length;
      const offset = item.position?.start.offset;
      if (offset === undefined) continue;
      const match = /^([-+*][ \t]+\[)([ xX/])\][ \t]+([^\r\n]+)/.exec(
        content.slice(offset),
      );
      if (match?.[1] && match[3]) {
        const end = offset + match[0].trimEnd().length;
        const paragraph = item.children[0];
        const link =
          paragraph?.type === "paragraph"
            ? paragraph.children.find(
                (child) =>
                  child.type === "link" && child.position?.end.offset === end,
              )
            : undefined;
        const linkStart = link?.position?.start.offset;
        const linkEnd = link?.position?.end.offset;
        const pubkey = link?.type === "link" ? profileKey(link.url) : undefined;
        const name =
          link?.type === "link" &&
          link.children.length === 1 &&
          link.children[0]?.type === "text"
            ? link.children[0].value
            : undefined;
        const assignee =
          pubkey &&
          name &&
          linkStart !== undefined &&
          linkEnd === end &&
          link?.type === "link" &&
          !link.title &&
          content
            .slice(linkStart, linkEnd)
            .endsWith(`](${profileTarget(pubkey)})`) &&
          content.slice(linkStart - assignment.length, linkStart) === assignment
            ? { pubkey, name, start: linkStart - assignment.length }
            : undefined;
        const named = assignee
          ? null
          : / · Assignee: ([\p{L}\p{N}][\p{L}\p{N} .’'_-]*)$/u.exec(
              content.slice(offset, end),
            );
        const namedText =
          paragraph?.type === "paragraph" &&
          paragraph.children.some(
            (child) =>
              child.type === "text" &&
              (child.position?.start.offset ?? Infinity) <=
                offset + (named?.index ?? 0) &&
              (child.position?.end.offset ?? -1) >= end,
          );
        const namedAssignee =
          named?.[1] && namedText
            ? { name: named[1].trim(), start: offset + named.index }
            : undefined;
        items.push({
          offset: offset + match[1].length,
          label: content
            .slice(
              offset + match[0].length - match[3].length,
              assignee?.start ?? namedAssignee?.start ?? end,
            )
            .trim(),
          status:
            match[2] === " " ? "todo" : match[2] === "/" ? "doing" : "done",
          end,
          assignee,
          ...(namedAssignee ? { namedAssignee } : {}),
          parents,
        });
      }
      const todo = items.length > before ? items[items.length - 1] : undefined;
      for (const child of item.children)
        if (child.type === "list" && !child.ordered)
          visit(child.children, todo ? [...parents, todo.label] : parents);
    }
  }
  for (const node of section)
    if (node.type === "list" && !node.ordered) visit(node.children, []);
  return { items, start };
}

export function setStatus(content: string, offset: number, status: Status) {
  if (!readTodos(content).items.some((item) => item.offset === offset))
    throw new Error("This todo changed. Reload the Canvas before editing it.");
  return content.slice(0, offset) + marks[status] + content.slice(offset + 1);
}

export function addTodo(content: string, label: string) {
  const text = label.trim();
  if (!text || /[\r\n]/.test(text))
    throw new Error("Use a single line for your todo.");
  const { start, items } = readTodos(content);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const line = `- [ ] ${text}`;
  const next =
    start === undefined
      ? `${content}${content ? newline + newline : ""}## Todos${newline}${newline}${line}${newline}`
      : `${content.slice(0, start)}${newline}${newline}${line}${newline}${content.slice(start)}`;
  if (readTodos(next).items.length !== items.length + 1)
    throw new Error(
      "Could not add a todo safely. Check Canvas for unfinished Markdown blocks.",
    );
  return next;
}

/** Edit only the readable assignment suffix, leaving the rest of the Canvas intact. */
export function assignTodo(
  content: string,
  offset: number,
  assignee?: Assignee,
) {
  const { items } = readTodos(content);
  const item = items.find((item) => item.offset === offset);
  if (!item)
    throw new Error("This todo changed. Reload the Canvas before editing it.");
  const target = assignee && profileTarget(assignee.pubkey);
  if (assignee && !target) throw new Error("Choose a valid Buzz user.");
  const name =
    assignee?.name.replace(/\s+/g, " ").trim() || assignee?.pubkey || "";
  const escaped = name.replace(/[\\`*_{}[\]()#+\-.!<>|&]/g, "\\$&");
  const suffix = assignee ? `${assignment}[${escaped}](${target})` : "";
  const start = item.assignee?.start ?? item.namedAssignee?.start ?? item.end;
  const next = content.slice(0, start) + suffix + content.slice(item.end);
  const parsed = readTodos(next);
  const edited = parsed.items.find((value) => value.offset === offset);
  if (
    parsed.items.length !== items.length ||
    edited?.label !== item.label ||
    edited?.assignee?.pubkey !== assignee?.pubkey.toLowerCase()
  )
    throw new Error(
      "Could not assign safely. Check this todo’s Markdown in Canvas.",
    );
  return next;
}

const FILLER = new Set(["the", "a", "an", "to", "todo", "todos", "item", "task", "one", "about", "for", "on", "in", "of", "and", "that", "this", "it", "list", "mark", "as", "is"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !FILLER.has(word));
}

/** The todo whose words best cover how the speaker described it. */
export function findTodo(items: Todo[], phrase: string, prefer?: (item: Todo) => boolean): Todo | null {
  const wanted = words(phrase);
  if (wanted.length === 0) return null;
  let best: Todo | null = null;
  let bestScore = 0;
  for (const item of items) {
    const have = new Set(words(item.label));
    const hits = wanted.filter((word) => have.has(word) || [...have].some((h) => h.length > 3 && (h.startsWith(word) || word.startsWith(h)))).length;
    const score = hits / wanted.length + (prefer?.(item) ? 0.01 : 0);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}
