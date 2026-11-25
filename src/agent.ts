import { llmStream, type Host, type Settings } from "./engine";
import { SentenceBuffer, type StreamToolCall } from "./stream";

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_channels",
      description: "List available Buzz channels and their descriptions.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_channel",
      description: "Read the most recent threads in a Buzz channel and bring that channel into focus.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name (exact or approximate)." },
          limit: { type: "integer", description: "Number of recent threads to inspect (default 8, max 15)." },
        },
        required: ["channel"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_thread",
      description: "Read the full messages of a specific thread in focus, by thread number, or by topic hint.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name (optional if already in focus)." },
          thread_ref: { type: "integer", description: "1-based thread number from the current scope." },
          thread_hint: { type: "string", description: "Short topic description if referring to a thread by subject." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_inbox",
      description: "Check unread @mentions and notifications waiting on the owner across all channels.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", description: "How many days back to check (default 3)." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_todos",
      description: "Read the Canvas todo list for a channel.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name (optional if already in focus)." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_message",
      description:
        "Draft (or update the current draft of) a Buzz message or task assignment. Depending on user settings this opens a confirmation card or sends immediately.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Target channel name (optional if continuing current focus)." },
          message: {
            type: "string",
            description:
              "Direct message body without routing wrappers like 'tell X to'. Keep domain terms, hostnames, repos, and branch names verbatim.",
          },
          recipient: { type: "string", description: "Person or agent to @mention (optional)." },
          thread_ref: { type: "integer", description: "1-based thread number in current scope to reply in." },
          thread_hint: { type: "string", description: "Topic description of an existing thread to reply in." },
          new_thread: { type: "boolean", description: "True only when explicitly starting a brand new top-level thread." },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_draft",
      description: "Send or save the currently pending message or todo draft after the user confirms.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_draft",
      description: "Cancel and discard the currently pending message or todo draft.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_todo",
      description: "Add, assign, start, finish, or reopen a todo item on a channel's Canvas todo list.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name (optional if already in focus)." },
          op: { type: "string", enum: ["add", "start", "done", "reopen", "assign"] },
          label: { type: "string", description: "Todo text (for add) or phrase matching an existing todo." },
          assignee: { type: "string", description: "Person or agent to assign (optional, required for op=assign)." },
          thread_hint: { type: "string", description: "Optional thread topic to post the assignment notification in." },
        },
        required: ["op", "label"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tracked_status",
      description: "Check the status reactions (working, stalled, done, needs-input) on recently tracked threads.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["all", "working", "stalled", "done", "needs-input"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flag_thread",
      description: "Add an emoji reaction flag (e.g. 👀, 🔄, ✅, ⛔) to the focused or referenced thread.",
      parameters: {
        type: "object",
        properties: {
          emoji: { type: "string", description: "Emoji to react with." },
          channel: { type: "string", description: "Channel name (optional if in focus)." },
          thread_ref: { type: "integer", description: "1-based thread number in current scope (optional)." },
        },
        required: ["emoji"],
        additionalProperties: false,
      },
    },
  },
] as const;

export interface AgentContextSnapshot {
  channels: { name: string; description?: string }[];
  people: string[];
  scopeSummary: string;
  pendingSummary: string;
  watchesSummary: string;
  confirmBeforeSend: boolean;
}

export function buildSystemPrompt(ctx: AgentContextSnapshot): string {
  const channelsList = ctx.channels
    .slice(0, 80)
    .map((c) => `- ${c.name}${c.description ? `: ${c.description.replace(/\s+/g, " ").slice(0, 120)}` : ""}`)
    .join("\n");

  return [
    "You are Buzz Voice, a fast, reactive spoken voice collaborator inside Buzz.",
    "Speak naturally and concisely in plain English: 1 to 3 short sentences, under 45 words unless asked for more detail.",
    "Never use markdown, bullet lists, code blocks, raw URLs, or event IDs in your spoken replies.",
    "When you need to read from Buzz (channels, threads, inbox, todos), say a tiny 2 to 5 word spoken acknowledgement first (like 'Checking ops.' or 'Looking at your inbox.') alongside the tool call so the user hears instant feedback.",
    "Never guess or invent channel messages, agent replies, or todos—always call the tool first.",
    "Speech recognition often mangles channel and agent names (numbers as words, spelled-out letters); match them by sound to the lists below.",
    "Preserve domain terms (hostnames, repo names, branches, agent names) verbatim when drafting messages.",
    ctx.confirmBeforeSend
      ? "Confirm-before-send is ON: draft_message and manage_todo stage a draft for the user to approve. Read back a brief 1-sentence confirmation and wait for them to say yes, edit it, or cancel."
      : "Confirm-before-send is OFF: draft_message and manage_todo execute immediately. Confirm briefly once done.",
    "",
    "Channels:",
    channelsList || "(none loaded yet)",
    ...(ctx.people.length ? ["", `Known people/agents: ${ctx.people.slice(0, 120).join(", ")}`] : []),
    ...(ctx.scopeSummary ? ["", `Current focus:\n${ctx.scopeSummary}`] : []),
    ...(ctx.pendingSummary ? ["", `Active pending draft:\n${ctx.pendingSummary}`] : []),
    ...(ctx.watchesSummary ? ["", `Watched threads:\n${ctx.watchesSummary}`] : []),
  ].join("\n");
}

export interface AgentRunOptions {
  host: Host;
  settings: Settings;
  history: AgentMessage[];
  context: () => AgentContextSnapshot;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<{ result: string; label?: string }>;
  onActivity: (label: string) => void;
  onTextUpdate: (text: string) => void;
  onSpeak: (sentence: string) => void;
  signal: AbortSignal;
}

export interface AgentRunResult {
  spoken: string;
  aborted: boolean;
  newMessages: AgentMessage[];
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const MAX_STEPS = 5;

/**
 * Runs a streaming, multi-step conversational tool-calling turn with sentence-buffered TTS
 * and instant AbortSignal cancellation for barge-in.
 */
export async function runAgentTurn(opts: AgentRunOptions): Promise<AgentRunResult> {
  const added: AgentMessage[] = [];
  const sentences = new SentenceBuffer();
  let allSpoken = "";

  const emitSentence = (sentence: string) => {
    if (opts.signal.aborted) return;
    opts.onSpeak(sentence);
  };

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (opts.signal.aborted) {
      return { spoken: allSpoken, aborted: true, newMessages: added };
    }

    const system = buildSystemPrompt(opts.context());
    const messages: AgentMessage[] = [{ role: "system", content: system }, ...opts.history, ...added];
    let stepText = "";

    const body: Record<string, unknown> = {
      model: opts.settings.llmModel || "default",
      messages,
      tools: AGENT_TOOLS,
      tool_choice: "auto",
      max_tokens: 420,
      chat_template_kwargs: { enable_thinking: false },
    };

    let result;
    try {
      result = await llmStream(
        opts.host,
        opts.settings,
        body,
        (delta) => {
          if (opts.signal.aborted) return;
          stepText += delta;
          const combined = allSpoken ? `${allSpoken}\n${stepText}` : stepText;
          opts.onTextUpdate(combined.trim());
          sentences.push(delta, emitSentence);
        },
        opts.signal,
      );
    } catch (error) {
      if (opts.signal.aborted) {
        return { spoken: (allSpoken ? `${allSpoken} ${stepText}` : stepText).trim(), aborted: true, newMessages: added };
      }
      // Retry once without chat_template_kwargs in case the endpoint rejects unknown parameters
      if (step === 0 && /chat_template_kwargs|unknown|extra_forbidden|unrecognized/i.test(String(error))) {
        delete body.chat_template_kwargs;
        stepText = "";
        sentences.reset();
        result = await llmStream(
          opts.host,
          opts.settings,
          body,
          (delta) => {
            if (opts.signal.aborted) return;
            stepText += delta;
            const combined = allSpoken ? `${allSpoken}\n${stepText}` : stepText;
            opts.onTextUpdate(combined.trim());
            sentences.push(delta, emitSentence);
          },
          opts.signal,
        );
      } else {
        throw error;
      }
    }

    sentences.flush(emitSentence);
    sentences.reset();

    if (opts.signal.aborted) {
      return { spoken: (allSpoken ? `${allSpoken} ${stepText}` : stepText).trim(), aborted: true, newMessages: added };
    }

    const finalText = (result.content || stepText).trim();
    if (finalText) {
      allSpoken = allSpoken ? `${allSpoken}\n${finalText}` : finalText;
      opts.onTextUpdate(allSpoken);
    }

    const toolCalls: StreamToolCall[] = result.toolCalls;
    if (toolCalls.length === 0) {
      if (finalText) added.push({ role: "assistant", content: finalText });
      return { spoken: allSpoken, aborted: false, newMessages: added };
    }

    added.push({
      role: "assistant",
      content: finalText,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments || "{}" },
      })),
    });

    const toolLabels = toolCalls.map((tc) => friendlyToolLabel(tc.name, parseArgs(tc.arguments)));
    opts.onActivity(toolLabels[0] || "Checking Buzz...");

    const outputs = await Promise.all(
      toolCalls.map(async (tc) => {
        if (opts.signal.aborted) return { id: tc.id, content: "Aborted." };
        try {
          const out = await opts.executeTool(tc.name, parseArgs(tc.arguments));
          return { id: tc.id, content: out.result };
        } catch (err) {
          return { id: tc.id, content: `Error: ${err instanceof Error ? err.message : String(err)}` };
        }
      }),
    );

    if (opts.signal.aborted) {
      return { spoken: allSpoken, aborted: true, newMessages: added };
    }

    for (const output of outputs) {
      added.push({ role: "tool", tool_call_id: output.id, content: output.content });
    }
    opts.onActivity("Thinking...");
  }

  return { spoken: allSpoken, aborted: false, newMessages: added };
}

function friendlyToolLabel(name: string, args: Record<string, unknown>): string {
  const ch = typeof args.channel === "string" && args.channel ? `#${args.channel}` : "";
  switch (name) {
    case "list_channels":
      return "Listing channels...";
    case "read_channel":
      return ch ? `Reading ${ch}...` : "Reading channel...";
    case "read_thread":
      return ch ? `Reading thread in ${ch}...` : "Reading thread...";
    case "check_inbox":
      return "Checking inbox...";
    case "list_todos":
      return ch ? `Reading ${ch} todos...` : "Reading todos...";
    case "draft_message":
      return ch ? `Drafting for ${ch}...` : "Drafting message...";
    case "send_draft":
      return "Sending...";
    case "cancel_draft":
      return "Cancelling draft...";
    case "manage_todo":
      return ch ? `Updating ${ch} todos...` : "Updating todos...";
    case "tracked_status":
      return "Checking tracked work...";
    case "flag_thread":
      return "Flagging thread...";
    default:
      return "Working...";
  }
}
