export interface Event {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  members?: readonly string[];
  readOnly?: boolean;
}

export interface Thread {
  rootId: string;
  messages: Event[];
  lastAt: number;
}

export interface Member {
  pubkey: string;
  name: string;
}

export type ThreadState = "working" | "stalled" | "done" | "needs-input" | "unknown";

export interface Turn {
  role: "you" | "app";
  text: string;
}

export type LlmPost = (body: unknown) => Promise<string>;

export type DecisionQuestion =
  | { type: "yes_no"; instructions: string }
  | { type: "choice"; instructions: string; options: Record<string, string> };

export type DecisionAnswer =
  | { type: "yes_no"; probability: number }
  | { type: "choice"; choice: string; confidence: number }
  | { type: "score"; score: number; confidence: number };

export type DecisionResult =
  | { outcome: "answered"; answers: Record<string, DecisionAnswer> }
  | { outcome: "failed"; reason: string };

export type Decide = (request: {
  state: string;
  questions: Record<string, DecisionQuestion>;
  timeoutMs?: number;
  community?: string;
}) => Promise<DecisionResult>;

export function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function rootOf(event: Event): string {
  const marked = event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1];
  return marked ?? event.tags.find((tag) => tag[0] === "e" && tag[1])?.[1] ?? event.id;
}
