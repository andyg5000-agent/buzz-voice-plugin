/** Streaming LLM SSE parser and low-latency sentence chunker for pipelined TTS playback. */

export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/nostr:\S+/g, " ")
    .replace(/[*_~#>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|fig|no|vol)\.\s*$/i;
const MIN_SENTENCE_CHARS = 18;
const CLAUSE_SPLIT_AT = 85;

/**
 * Buffers streamed assistant tokens and emits natural spoken sentences as soon as
 * a boundary arrives so sentence 1 starts playing while sentence 2 is still generating.
 */
export class SentenceBuffer {
  private buf = "";
  private emittedAny = false;

  push(delta: string, onSentence: (sentence: string) => void): void {
    if (!delta) return;
    this.buf += delta;
    this.drain(false, onSentence);
  }

  flush(onSentence: (sentence: string) => void): void {
    this.drain(true, onSentence);
    const tail = cleanForSpeech(this.buf);
    this.buf = "";
    if (tail) onSentence(tail);
  }

  reset(): void {
    this.buf = "";
    this.emittedAny = false;
  }

  private drain(final: boolean, onSentence: (sentence: string) => void): void {
    for (;;) {
      const cut = this.findCut(final);
      if (cut < 0) break;
      const piece = cleanForSpeech(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
      if (piece) {
        this.emittedAny = true;
        onSentence(piece);
      }
    }
  }

  private findCut(final: boolean): number {
    // Never cut inside an unclosed fenced code block
    const fences = (this.buf.match(/```/g) ?? []).length;
    if (!final && fences % 2 === 1) return -1;

    // Paragraph or line break
    const nl = this.buf.indexOf("\n");
    if (nl >= 0) {
      const before = this.buf.slice(0, nl).trim();
      if (before.length >= 6 || this.emittedAny) return nl + 1;
    }

    // Sentence punctuation followed by whitespace (or end on flush)
    const sentenceRe = /([.!?])(?:\s+|$)/g;
    let match: RegExpExecArray | null;
    while ((match = sentenceRe.exec(this.buf)) !== null) {
      const end = match.index + match[0].length;
      if (!final && end === this.buf.length && !/\s$/.test(match[0])) continue;
      const head = this.buf.slice(0, match.index + 1);
      // Skip decimals/versions like "v2.0" or "3.14"
      if (match[1] === "." && /\d$/.test(this.buf.slice(0, match.index)) && /^\d/.test(this.buf.slice(match.index + 1))) {
        continue;
      }
      if (match[1] === "." && ABBREV.test(head)) continue;
      if (head.trim().length >= MIN_SENTENCE_CHARS || this.emittedAny || match[1] !== ".") {
        return end;
      }
    }

    // Long sentence without a period yet: split at a natural clause boundary so first audio starts fast
    if (this.buf.length >= CLAUSE_SPLIT_AT) {
      const clauseRe = /([;:]|—|--|,)\s+/g;
      while ((match = clauseRe.exec(this.buf)) !== null) {
        if (match.index >= 45) return match.index + match[0].length;
      }
    }

    return -1;
  }
}

export interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamResult {
  content: string;
  toolCalls: StreamToolCall[];
  finishReason: string | null;
}

/** Incremental OpenAI SSE / plain JSON response accumulator. */
export class SseParser {
  private partial = "";
  private raw = "";
  private sawSse = false;
  private content = "";
  private finishReason: string | null = null;
  private calls = new Map<number, StreamToolCall>();
  private error: string | null = null;

  constructor(private readonly onDelta?: (text: string) => void) {}

  feed(chunk: string): void {
    this.raw += chunk;
    this.partial += chunk;
    const lines = this.partial.split(/\r?\n/);
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line);
  }

  finish(): StreamResult {
    if (this.partial.trim()) this.handleLine(this.partial);
    this.partial = "";

    if (this.error) throw new Error(this.error);

    // Non-streaming fallback if server returned plain JSON despite stream:true
    if (!this.sawSse && this.raw.trim().startsWith("{")) {
      const parsed = JSON.parse(this.raw.trim());
      if (parsed?.error) throw new Error(parsed.error.message ?? String(parsed.error));
      const choice = parsed?.choices?.[0];
      const msg = choice?.message;
      const text = typeof msg?.content === "string" ? msg.content : "";
      if (text) {
        this.content = text;
        this.onDelta?.(text);
      }
      const toolCalls: StreamToolCall[] = Array.isArray(msg?.tool_calls)
        ? msg.tool_calls.map((tc: any, idx: number) => ({
            id: String(tc.id ?? `call_${idx}`),
            name: String(tc.function?.name ?? ""),
            arguments:
              typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments ?? {}),
          }))
        : [];
      return {
        content: this.content,
        toolCalls,
        finishReason: choice?.finish_reason ?? null,
      };
    }

    const toolCalls = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((call) => call.name);
    return { content: this.content, toolCalls, finishReason: this.finishReason };
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;
    this.sawSse = true;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed?.error) {
      this.error = parsed.error.message ?? String(parsed.error);
      return;
    }
    const choice = parsed?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = String(choice.finish_reason);
    const delta = choice.delta ?? choice.message;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content) {
      this.content += delta.content;
      this.onDelta?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === "number" ? tc.index : this.calls.size;
        const entry = this.calls.get(index) ?? {
          id: `call_${index}`,
          name: "",
          arguments: "",
        };
        if (typeof tc.id === "string" && tc.id) entry.id = tc.id;
        if (typeof tc.function?.name === "string" && tc.function.name) entry.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") entry.arguments += tc.function.arguments;
        this.calls.set(index, entry);
      }
    }
  }
}
