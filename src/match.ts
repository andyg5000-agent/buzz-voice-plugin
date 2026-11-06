import type { Channel } from "./types";

const ONES: Record<string, number> = {
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
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
function digits(text: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const tens = TENS[word];
    if (tens !== undefined) {
      const next = ONES[words[i + 1] ?? ""];
      if (next !== undefined && next < 10) {
        out.push(String(tens + next));
        i += 1;
        continue;
      }
      out.push(String(tens));
      continue;
    }
    const ones = ONES[word];
    out.push(ones === undefined ? word : String(ones));
  }
  return out.join(" ");
}
export function canon(text: string): string {
  return digits(text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim())
    .replace(/[^a-z0-9]+/g, "")
    .replace(/(.)\1+/g, "$1");
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length];
}

function tolerance(name: string): number {
  if (name.length <= 3) return 0;
  if (name.length <= 6) return 1;
  return 2;
}
function score(rawName: string, phrase: string): number | null {
  const name = canon(rawName);
  const spoken = canon(phrase);
  if (!name || !spoken) return null;
  if (spoken === name) return 0;
  if (spoken.includes(name)) return 1;

  const allowed = tolerance(name);
  if (allowed === 0) return null;

  let best = Infinity;
  for (let start = 0; start < spoken.length; start += 1) {
    for (const width of [name.length - 1, name.length, name.length + 1]) {
      if (width <= 0 || start + width > spoken.length) continue;
      best = Math.min(best, distance(spoken.slice(start, start + width), name));
    }
  }
  return best <= allowed ? 2 + best : null;
}
const CLASS: Record<string, string> = {
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
  w: "w",
};

function fold(text: string): string {
  return canon(text)
    .split("")
    .map((ch) => (/[0-9]/.test(ch) ? ch : (CLASS[ch] ?? "")))
    .join("")
    .replace(/(.)\1+/g, "$1");
}
function variants(rawName: string): string[] {
  const words = rawName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return [...new Set(words.filter((word) => word.length > 2))];
}
function scoreName(rawName: string, phrase: string): number | null {
  const direct = score(rawName, phrase);
  if (direct !== null) return direct;

  for (const variant of variants(rawName)) {
    const hit = score(variant, phrase);
    if (hit !== null) return 5 + hit;
  }
  return null;
}

function scorePerson(rawName: string, phrase: string): number | null {
  const strict = scoreName(rawName, phrase);
  if (strict !== null) return strict;

  const spoken = fold(phrase);
  if (!spoken) return null;
  for (const candidate of [rawName, ...variants(rawName)]) {
    const name = fold(candidate);
    if (name.length < 3) continue;
    if (spoken.includes(name)) return 10;
    const allowed = tolerance(name);
    for (let start = 0; start + name.length <= spoken.length + 1; start += 1) {
      for (const width of [name.length - 1, name.length, name.length + 1]) {
        if (width <= 0 || start + width > spoken.length) continue;
        if (distance(spoken.slice(start, start + width), name) <= allowed) return 12;
      }
    }
  }
  return null;
}
function pick<T>(
  items: T[],
  nameOf: (item: T) => string,
  scorer: (name: string, phrase: string) => number | null,
  phrases: (string | null)[],
): T | null {
  for (const phrase of phrases) {
    if (!phrase?.trim()) continue;
    let winner: T | null = null;
    let winning = Infinity;
    for (const item of items) {
      const result = scorer(nameOf(item), phrase);
      if (result === null) continue;
      const better =
        result < winning ||
        (result === winning &&
          canon(nameOf(item)).length > canon(winner ? nameOf(winner) : "").length);
      if (better) {
        winning = result;
        winner = item;
      }
    }
    if (winner) return winner;
  }
  return null;
}

export function bestMatch<T>(
  items: T[],
  nameOf: (item: T) => string,
  ...phrases: (string | null)[]
): T | null {
  return pick(items, nameOf, score, phrases);
}
export function bestPerson<T>(
  items: T[],
  nameOf: (item: T) => string,
  spoken: string | null,
  transcript: string | null,
): T | null {
  return (
    pick(items, nameOf, scorePerson, [spoken]) ?? pick(items, nameOf, score, [transcript])
  );
}

const BEFORE_CHANNEL = /((?:\S+\s+){0,3}\S+)\s+channels?\b/gi;
const AFTER_CHANNEL = /\bchannels?\s+((?:\S+\s+){0,2}\S+)/gi;
const CUE = /\b(?:in|on|to|into|from)\s+(?:the\s+)?((?:\S+\s+){0,3}\S+)/gi;

function hits(pattern: RegExp, text: string): string[] {
  const found: string[] = [];
  pattern.lastIndex = 0;
  let hit = pattern.exec(text);
  while (hit) {
    if (hit[1]?.trim()) found.push(hit[1].trim());
    hit = pattern.exec(text);
  }
  return found;
}
export function channelPhrases(text: string): string[] {
  const explicit = [...hits(BEFORE_CHANNEL, text), ...hits(AFTER_CHANNEL, text)];
  if (explicit.length > 0) return explicit;
  const loose = hits(CUE, text);
  return loose.length > 0 ? loose : [text];
}

export function matchChannel(
  channels: Channel[],
  spoken: string | null,
  transcript: string,
): Channel | null {
  return bestMatch(channels, (c) => c.name, spoken, ...channelPhrases(transcript));
}
