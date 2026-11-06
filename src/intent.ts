import { canon } from "./match";
import type { Scope } from "./scope";
import type { Channel, Decide, DecisionAnswer, LlmPost, ThreadState, Turn } from "./types";

export interface Intent {
  action: "post" | "status" | "inbox" | "unknown";
  channel: string | null;
  recipient: string | null;
  continues_previous: boolean;
  thread: "new" | "existing";
  thread_ref: number | null;
  thread_hint: string | null;
  new_thread: boolean;
  instruction: string;
  filter: ThreadState | "all";
  spoken_confirmation: string;
}

const ROUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["post", "status", "inbox", "unknown"],
      description:
        "post when the speaker is assigning work or sending a message, status when they are asking about work in a channel, inbox when they ask about their inbox, unreads, notifications or what is waiting on them.",
    },
    channel: {
      type: ["string", "null"],
      description: "Exact channel name from the provided list, or null if none was named.",
    },
    recipient: {
      type: ["string", "null"],
      description:
        "The agent or person the speaker told to do the work, as they said it, or null if they addressed nobody. Drop words like bot and agent.",
    },
    continues_previous: {
      type: "boolean",
      description:
        'True when the speaker is building on the previous exchange rather than starting something new, for example "act on that".',
    },
    thread: {
      type: "string",
      enum: ["new", "existing"],
      description:
        'existing when the speaker is replying inside a thread that is already in scope, for example "reply in that thread". new otherwise.',
    },
    thread_ref: {
      type: ["integer", "null"],
      description:
        "The number of the scope thread the speaker means, from the numbered list of threads in scope, or null when they named none.",
    },
    thread_hint: {
      type: ["string", "null"],
      description:
        'How the speaker described the thread when they described it by subject instead of by number, in their own words and nothing else. From "the thread about the login bug in ops" it is "login bug". Null when they described no thread. "the latest thread" and "the newest one" are not descriptions, they are null.',
    },
    new_thread: {
      type: "boolean",
      description:
        'True only when the speaker explicitly asked for a new thread or a new topic, for example "start a new thread about X". False for everything else, including a sentence that names no thread at all.',
    },
    instruction: {
      type: "string",
      description:
        'The message to post, as a direct instruction addressed to nobody. Keep the speaker\'s own wording and their domain terms verbatim. Strip the routing framing: the thread or channel the speaker picked out, and any "tell NAME", "tell NAME to" or "ask NAME to" wrapper. The recipient is tagged separately, so naming them here says it twice. From "in the thread about the login bug in ops tell build-bot that the fix is live" the instruction is "The fix is live." Empty for status actions.',
    },
    filter: {
      type: "string",
      enum: ["working", "stalled", "done", "needs-input", "all"],
      description: "Which tracked threads the speaker asked about. Use all when unspecified.",
    },
    spoken_confirmation: {
      type: "string",
      description:
        "What is read back before sending. Name the channel and the gist in at most 12 words. No pleasantries.",
    },
  },
  required: [
    "action",
    "channel",
    "recipient",
    "continues_previous",
    "thread",
    "thread_ref",
    "thread_hint",
    "new_thread",
    "instruction",
    "filter",
    "spoken_confirmation",
  ],
} as const;

const WORDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    instruction: ROUTE_SCHEMA.properties.instruction,
    thread_hint: ROUTE_SCHEMA.properties.thread_hint,
    spoken_confirmation: ROUTE_SCHEMA.properties.spoken_confirmation,
  },
  required: ["instruction", "thread_hint", "spoken_confirmation"],
} as const;

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: {
      type: "string",
      description:
        "The spoken answer in at most two sentences and under 40 words. Answer only what was asked, lead with it, and leave out background, process and caveats. No markdown, no lists, no links, no event ids. Name who said it. Say plainly if the messages do not answer the question.",
    },
    thread: {
      type: ["integer", "null"],
      description:
        'The number of the thread the answer came from, or null if the answer draws on several threads or none. The speaker\'s next sentence may be "reply in that thread", so this has to be the thread being talked about.',
    },
  },
  required: ["answer", "thread"],
} as const;

const PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thread: {
      type: ["integer", "null"],
      description:
        "The number of the thread the speaker meant, or null when none of them is what they described. Judge it on subject, not on wording: they are working from memory and will not repeat a thread's opening line.",
    },
  },
  required: ["thread"],
} as const;

export interface LlmConfig {
  model: string;
  post: LlmPost;
}

type Message = { role: string; content: string };

function clean(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  return ["null", "none", "unknown", "n/a"].includes(text.toLowerCase()) ? null : text;
}

function firstJson(text: string): unknown | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function ask<T>(
  llm: LlmConfig,
  name: string,
  schema: unknown,
  messages: Message[],
  maxTokens: number,
): Promise<T> {
  const base = {
    model: llm.model,
    max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false },
    messages,
  };
  const guided = {
    ...base,
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
  };
  const tooled = {
    ...base,
    tool_choice: { type: "function", function: { name } },
    tools: [{ type: "function", function: { name, parameters: schema } }],
  };

  let failure = "the model did not return a decision";
  for (const body of [guided, guided, tooled]) {
    let parsed: any;
    try {
      parsed = JSON.parse(await llm.post(body));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (parsed?.error) {
      failure = parsed.error.message ?? String(parsed.error);
      continue;
    }
    const message = parsed?.choices?.[0]?.message;
    const text = message?.tool_calls?.[0]?.function?.arguments ?? message?.content ?? "";
    const value = firstJson(String(text));
    if (value) return value as T;
  }
  throw new Error(failure);
}

const history = (turns: Turn[]): Message[] =>
  turns.map((turn) => ({ role: turn.role === "you" ? "user" : "assistant", content: turn.text }));

const DOMAIN_TERMS = [
  "The speaker uses domain terms: hostnames, repo names, agent names, branch names.",
  "Copy them through exactly as transcribed. Never expand an abbreviation and never",
  "replace a word with a more common one you think they meant.",
  "Earlier turns of this session are included. Use them to resolve references",
  'like "that", "them" or "the previous message", and write an instruction that',
  "stands on its own without them.",
];

async function wordsOnly(llm: LlmConfig, transcript: string, turns: Turn[]): Promise<Partial<Intent>> {
  const system = [
    "You write the message body for a spoken Buzz command.",
    "Where the message goes has already been decided, so your only job is the words.",
    ...DOMAIN_TERMS,
    "The instruction is the message body and nothing else. Leave out which",
    "thread and which channel they picked, and leave out the recipient's name:",
    "they are tagged separately and the name would appear twice.",
    "When they pick a thread out by what it is about, put that description in",
    "thread_hint in their own words. Null when they described no thread.",
    "Answer with one JSON object and nothing else.",
  ].join("\n");
  return ask<Partial<Intent>>(
    llm,
    "words",
    WORDS_SCHEMA,
    [{ role: "system", content: system }, ...history(turns), { role: "user", content: transcript }],
    512,
  );
}

const NO_CHANNEL = "no_channel";
const NOBODY = "nobody";
const NO_THREAD = "none";
const MAX_OPTIONS = 250;

function choiceOf(answers: Record<string, DecisionAnswer>, id: string): string | null {
  const answer = answers[id];
  return answer?.type === "choice" ? answer.choice : null;
}

function yes(answers: Record<string, DecisionAnswer>, id: string): boolean {
  const answer = answers[id];
  return answer?.type === "yes_no" && answer.probability > 0.5;
}

function short(text: string | undefined, fallback: string): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return (flat || fallback).slice(0, 200);
}

interface Routed {
  action: "post" | "status" | "inbox";
  channel: string | null;
  recipient: string | null;
  thread_ref: number | null;
  new_thread: boolean;
  continues_previous: boolean;
  filter: Intent["filter"];
}

async function decideRoute(
  decide: Decide,
  community: string | undefined,
  transcript: string,
  channels: Channel[],
  people: string[],
  scope: Scope,
  previous: string | null,
): Promise<Routed | null> {
  const channelOptions: Record<string, string> = {};
  for (const channel of channels.slice(0, MAX_OPTIONS - 1)) {
    channelOptions[channel.name] = short(channel.description, `The ${channel.name} channel.`);
  }
  channelOptions[NO_CHANNEL] = "The sentence names no channel.";

  const questions: Record<string, any> = {
    action: {
      type: "choice",
      instructions: "Classify the speaker's request.",
      options: {
        post: "The speaker is issuing an instruction or sending a message to someone else.",
        status: "The speaker is asking for an update about a named project, channel or thread.",
        inbox: "The speaker is asking about their own unread messages or notifications.",
      },
    },
    channel: {
      type: "choice",
      instructions:
        "Which chat channel did the speaker name? The sentence came from a speech recogniser, so names arrive mangled: letters are spelled out and digits come back as words. Match by sound, not by spelling.",
      options: channelOptions,
    },
    new_thread: {
      type: "yes_no",
      instructions: "The speaker explicitly asked for a new thread, a new topic or a separate thread.",
    },
    filter: {
      type: "choice",
      instructions: "Which tracked threads did the speaker ask about?",
      options: {
        working: "Only work still in progress.",
        stalled: "Only work that is stuck.",
        done: "Only finished work.",
        "needs-input": "Only work waiting on the speaker.",
        all: "They did not narrow it down.",
      },
    },
  };

  if (people.length) {
    const personOptions: Record<string, string> = {};
    for (const person of people.slice(0, MAX_OPTIONS - 1)) personOptions[person] = `The member named ${person}.`;
    personOptions[NOBODY] = "The speaker addressed no one in particular.";
    questions.recipient = {
      type: "choice",
      instructions:
        "Which agent or person did the speaker tell to do the work? Agents are often named after the machines they run on, so a recipient can sound like a channel. A channel name is never a recipient.",
      options: personOptions,
    };
  }

  if (scope.threads.length) {
    const threadOptions: Record<string, string> = {};
    scope.threads.forEach((thread, index) => {
      threadOptions[String(index + 1)] = short(thread.label, `Thread ${index + 1}.`);
    });
    threadOptions[NO_THREAD] = "They described no particular thread.";
    questions.thread = {
      type: "choice",
      instructions:
        "The speaker may have picked out one of the threads already in scope, by number or by what it is about. Which one?",
      options: threadOptions,
    };
  }

  if (previous) {
    questions.continues = {
      type: "yes_no",
      instructions: "The speaker is building on the previous exchange rather than starting something new.",
    };
  }

  const state = previous
    ? `Previous exchange: ${previous}\n\nSpoken now: ${transcript}`
    : `Spoken now: ${transcript}`;
  const result = await decide({ state, questions, timeoutMs: 15_000, community });
  if (result.outcome !== "answered") return null;
  const answers = result.answers;

  const action = choiceOf(answers, "action");
  const channel = choiceOf(answers, "channel");
  const recipient = choiceOf(answers, "recipient");
  const thread = choiceOf(answers, "thread");
  const filter = choiceOf(answers, "filter");
  const ref = thread && thread !== NO_THREAD ? Number(thread) : NaN;
  return {
    action: action === "status" || action === "inbox" ? action : "post",
    channel: channel && channel !== NO_CHANNEL ? channel : null,
    recipient: recipient && recipient !== NOBODY ? recipient : null,
    thread_ref: Number.isInteger(ref) && ref > 0 && ref <= scope.threads.length ? ref : null,
    new_thread: yes(answers, "new_thread"),
    continues_previous: yes(answers, "continues"),
    filter: (filter as Intent["filter"]) ?? "all",
  };
}

function scopeLines(scope: Scope): string[] {
  if (!scope.channel || scope.threads.length === 0) return [];
  const lines = [
    "",
    "In scope right now, from the last channel the speaker read or posted to.",
    `Channel: ${scope.channel.name}`,
    "Threads, newest last:",
    ...scope.threads.map(
      (thread, index) =>
        `  ${index + 1}. ${thread.label}${thread.who.length ? ` (${thread.who.join(", ")})` : ""}`,
    ),
  ];
  if (scope.focus) {
    const index = scope.threads.findIndex((t) => t.rootId === scope.focus?.rootId);
    if (index >= 0) {
      lines.push(
        `Thread ${index + 1} is the one just read back or posted to. "that thread" and "in there" mean it.`,
      );
    }
  }
  lines.push(
    "Set thread_ref to the number of the thread the speaker means and thread to existing.",
    "A sentence that starts something unrelated is thread new and thread_ref null.",
  );
  return lines;
}

export async function parseIntent(options: {
  llm: LlmConfig | null;
  decide: Decide | null;
  community?: string;
  transcript: string;
  channels: Channel[];
  people: string[];
  scope: Scope;
  turns: Turn[];
}): Promise<Intent> {
  const { llm, decide, community, transcript, channels, people, scope, turns } = options;

  if (decide) {
    const words = llm ? wordsOnly(llm, transcript, turns).catch(() => ({}) as Partial<Intent>) : null;
    const routed = await decideRoute(
      decide,
      community,
      transcript,
      channels,
      people,
      scope,
      turns.at(-1)?.text ?? null,
    ).catch(() => null);
    if (routed) {
      const said: Partial<Intent> = words ? await words : {};
      const recipient = clean(routed.recipient);
      return {
        action: routed.action,
        channel: routed.channel,
        recipient,
        continues_previous: routed.continues_previous,
        thread: routed.thread_ref !== null ? "existing" : "new",
        thread_ref: routed.thread_ref,
        thread_hint: describedThread(clean(said.thread_hint)),
        new_thread: routed.new_thread && WANTS_NEW.test(transcript),
        instruction: stripRouting(said.instruction || transcript, recipient),
        filter: routed.filter,
        spoken_confirmation: said.spoken_confirmation ?? "",
      };
    }
    if (words) await words;
  }

  if (!llm) throw new Error("Routing needs a Decisions provider or an LLM. Set one up in Settings.");

  const list = channels.map((c) => `${c.name}: ${c.description || "no description"}`).join("\n");
  const system = [
    "You turn a spoken sentence into a Buzz routing decision.",
    "The speaker owns these channels and the agents in them.",
    "The sentence comes from a speech recogniser, so channel names arrive mangled:",
    'letters are spelled out and digits come back as words, for example "abc12" is',
    'heard as "a b c twelve". Match the channel by sound and meaning, not by exact',
    "words, and always answer with a name from the list.",
    ...DOMAIN_TERMS,
    "When the speaker is telling an agent to do something, action is post.",
    "Agents are often named after the machines they run on, so a recipient can sound",
    "like a channel. The channel is where they said to go, never who they addressed.",
    "A channel name is never a recipient.",
    "The speaker works in threads. A sentence goes into an existing thread unless they",
    "explicitly ask for a new one, so new_thread is false almost always.",
    "When they pick a thread out by what it is about rather than by number, put",
    "that description in thread_hint. It is looked up against the real threads",
    "afterwards, so copy their words and do not guess a number.",
    "The instruction is the message body and nothing else. Leave out which",
    "thread and which channel they picked, and leave out the recipient's name:",
    "they are tagged separately and the name would appear twice.",
    "When they are asking how work is going, action is status.",
    "The inbox is what is unread and waiting on the speaker across every channel.",
    '"my inbox", "unreads", "notifications", "what is waiting on me" and',
    '"anything for me" are action inbox with channel null. Inbox is never a',
    "channel name, whatever the channels are called.",
    "Answer with one JSON object and nothing else.",
    "Channels:",
    list,
    ...(people.length
      ? [
          "",
          "The people and agents in these channels. Their names arrive mangled too,",
          "so map what was said onto one of these and answer with it verbatim:",
          people.join(", "),
        ]
      : []),
    ...scopeLines(scope),
  ].join("\n");

  const input = await ask<Partial<Intent>>(
    llm,
    "route",
    ROUTE_SCHEMA,
    [{ role: "system", content: system }, ...history(turns), { role: "user", content: transcript }],
    768,
  );

  const ref = typeof input.thread_ref === "number" && input.thread_ref > 0 ? input.thread_ref : null;
  const named = clean(input.recipient);
  const recipient = named && channels.some((c) => canon(c.name) === canon(named)) ? null : named;
  return {
    action: input.action ?? "unknown",
    channel: clean(input.channel),
    recipient,
    continues_previous: input.continues_previous ?? false,
    thread: input.thread === "existing" || ref !== null ? "existing" : "new",
    thread_ref: ref,
    thread_hint: describedThread(clean(input.thread_hint)),
    new_thread: input.new_thread === true && WANTS_NEW.test(transcript),
    instruction: stripRouting(input.instruction ?? "", recipient),
    filter: input.filter ?? "all",
    spoken_confirmation: input.spoken_confirmation ?? "",
  };
}

const WANTS_NEW =
  /\bnew\s+(?:thread|topic|conversation)\b|\bthread\s+(?:for|about)\s+(?:a\s+)?new\b|\bstart\s+(?:a|another)\s+thread\b|\bseparate\s+thread\b|\bown\s+thread\b|\btop\s*level\b/i;

function describedThread(hint: string | null): string | null {
  if (!hint) return null;
  const bare = hint.toLowerCase().replace(/^the\s+/, "").replace(/\s+(?:thread|one)$/, "").trim();
  return ["latest", "newest", "last", "recent", "most recent", "current", "same", "that", "this"].includes(bare)
    ? null
    : hint;
}

export function stripRouting(instruction: string, recipient: string | null): string {
  let text = instruction.trim();
  const name = recipient ? recipient.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
  const patterns = [
    /^(?:and\s+)?(?:in|on|under|to)\s+the\s+(?:existing\s+)?thread\s+(?:about|on|for|re|regarding|where|discussing)\b[^,.]*[,.]?\s*/i,
    /^(?:and\s+)?(?:in|on)\s+(?:that|this|the\s+(?:latest|newest|last|same|current))\s+thread\b[,.]?\s*/i,
    /^(?:and\s+)?in\s+(?:the\s+)?[\w.-]+\s+channel\b[,.]?\s*/i,
    ...(name
      ? [
          new RegExp(`^(?:and\\s+)?(?:please\\s+)?(?:tell|ask|let)\\s+@?${name}\\s+(?:that|to|know\\s+that|know)?\\s*`, "i"),
          new RegExp(`^@?${name}[,:]?\\s+`, "i"),
        ]
      : []),
    /^(?:and\s+)?(?:please\s+)?(?:tell|ask|let)\s+(?:them|him|her|the\s+agent)\s+(?:that|to|know\s+that|know)?\s*/i,
    /^(?:and\s+)?(?:please\s+)?(?:tell|ask)\s+(?=(?:that|the|this|it|we|i|he|she|they|there)\b)(?:that\s+)?/i,
    /^(?:start|open|post)\s+a\s+new\s+thread\s+(?:about|on|for|re)\s+/i,
  ];

  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    for (const pattern of patterns) text = text.replace(pattern, "").trim();
    text = stripSpokenName(text, recipient);
    if (text === before) break;
  }

  if (!text) return instruction.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function stripSpokenName(text: string, recipient: string | null): string {
  if (!recipient) return text;
  const lead = /^(?:and\s+)?(?:please\s+)?(?:tell|ask|let)\s+/i.exec(text);
  if (!lead) return text;
  const words = text.slice(lead[0].length).split(/\s+/);
  const wanted = canon(recipient);
  for (let take = Math.min(5, words.length); take >= 1; take -= 1) {
    if (canon(words.slice(0, take).join(" ")) !== wanted) continue;
    return words
      .slice(take)
      .join(" ")
      .replace(/^(?:that|to|know\s+that|know)\s+/i, "")
      .trim();
  }
  return text;
}

export async function pickThread(options: {
  llm: LlmConfig | null;
  decide: Decide | null;
  community?: string;
  channelName: string;
  hint: string | null;
  transcript: string;
  labels: string[];
}): Promise<number | null> {
  const { llm, decide, community, channelName, hint, transcript, labels } = options;
  if (labels.length === 0) return null;

  if (decide) {
    const opts: Record<string, string> = {};
    labels.forEach((label, index) => {
      opts[String(index + 1)] = short(label, `Thread ${index + 1}.`);
    });
    opts[NO_THREAD] = "They described no particular thread.";
    const result = await decide({
      state: `Channel: ${channelName}\nSpoken: ${transcript}${hint ? `\nThey called it: ${hint}` : ""}`,
      questions: {
        thread: {
          type: "choice",
          instructions:
            "The speaker named a thread by what it is about, not by its opening line. Which of these do they mean? They are working from memory and will not repeat the thread's own wording.",
          options: opts,
        },
      },
      timeoutMs: 15_000,
      community,
    }).catch(() => null);
    if (result?.outcome === "answered") {
      const picked = choiceOf(result.answers, "thread");
      const ref = picked && picked !== NO_THREAD ? Number(picked) : NaN;
      return Number.isInteger(ref) && ref > 0 && ref <= labels.length ? ref : null;
    }
  }

  if (!llm) return null;
  const input = await ask<{ thread?: number | null }>(
    llm,
    "pick",
    PICK_SCHEMA,
    [
      {
        role: "system",
        content: [
          `The speaker named a thread in the ${channelName} channel. Work out which one.`,
          "Threads, newest last, shown by their opening line:",
          ...labels.map((label, index) => `  ${index + 1}. ${label}`),
          "Answer with one JSON object and nothing else.",
        ].join("\n"),
      },
      { role: "user", content: hint ? `${transcript}\n\nThey called it: ${hint}` : transcript },
    ],
    200,
  );
  const ref = typeof input.thread === "number" && input.thread > 0 ? input.thread : null;
  return ref !== null && ref <= labels.length ? ref : null;
}

export interface ChannelAnswer {
  answer: string;
  thread: number | null;
}

export async function summarizeChannel(
  llm: LlmConfig,
  channelName: string,
  question: string,
  blocks: string[],
): Promise<ChannelAnswer> {
  return summarize(
    llm,
    [
      "You read a Buzz channel back to its owner out loud.",
      "The messages are grouped into numbered threads, oldest thread first,",
      "and each thread is oldest message first.",
      `Channel: ${channelName}`,
    ],
    question,
    blocks,
  );
}

export async function summarizeInbox(llm: LlmConfig, question: string, blocks: string[]): Promise<ChannelAnswer> {
  return summarize(
    llm,
    [
      "You read the speaker's Buzz inbox back to them out loud.",
      "Each numbered item is an unread thread that mentions them, oldest first,",
      "with its channel and the people in it.",
      "Open with the count, then the single item that most needs them.",
      "Do not list them all.",
      "Set thread to the number of the item you named, never null.",
      "In the spoken answer name that item by its channel and who is waiting,",
      "never by its number.",
    ],
    question,
    blocks,
  );
}

async function summarize(
  llm: LlmConfig,
  preamble: string[],
  question: string,
  blocks: string[],
): Promise<ChannelAnswer> {
  const input = await ask<Partial<ChannelAnswer>>(
    llm,
    "answer",
    ANSWER_SCHEMA,
    [
      {
        role: "system",
        content: [
          ...preamble,
          "Keep it to two sentences at most. They ask for detail when they want it.",
          "Answer with one JSON object and nothing else.",
          blocks.join("\n\n"),
        ].join("\n"),
      },
      { role: "user", content: question },
    ],
    700,
  );
  const answer = String(input.answer ?? "");
  if (!answer.trim()) throw new Error("the model returned no summary");
  const thread = typeof input.thread === "number" && input.thread > 0 ? input.thread : null;
  return { answer: answer.replace(/\s+/g, " ").trim(), thread };
}
