import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const scratch = mkdtempSync(join(tmpdir(), "bv-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

async function loadModule(entry) {
  const outfile = join(scratch, `${entry.replace(/\W+/g, "_")}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile,
    loader: { ".py": "text" },
  });
  return import(pathToFileURL(outfile).href);
}

const streamMod = await loadModule("src/stream.ts");
const agentMod = await loadModule("src/agent.ts");
const engineMod = await loadModule("src/engine.ts");
const controllerMod = await loadModule("src/controller.ts");

test("SentenceBuffer splits streamed sentences, preserves decimals/versions, and cleans markdown", () => {
  const buf = new streamMod.SentenceBuffer();
  const out = [];
  const emit = (s) => out.push(s);

  const chunks = [
    "Checking **ops** ",
    "now. Version v2.0.1 ",
    "is live at https://example.com/status ",
    "with 99.9% uptime! ",
    "Dr. Smith confirmed ",
    "`nginx` is healthy.",
  ];
  for (const c of chunks) buf.push(c, emit);
  buf.flush(emit);

  assert.deepEqual(out, [
    "Checking ops now.",
    "Version v2.0.1 is live at with 99.9% uptime!",
    "Dr. Smith confirmed nginx is healthy.",
  ]);
});

test("SentenceBuffer skips fenced code blocks and emits clause splits on long run-on sentences", () => {
  const buf = new streamMod.SentenceBuffer();
  const out = [];
  buf.push("First part is quite long and keeps going on without a period, ", (s) => out.push(s));
  buf.push("until it reaches a natural comma boundary after enough text, and then continues.", (s) => out.push(s));
  buf.flush((s) => out.push(s));
  assert.ok(out.length >= 2, `expected early clause split, got ${JSON.stringify(out)}`);
  assert.equal(streamMod.cleanForSpeech("Look:\n```ts\nconst x = 1;\n```\nDone!"), "Look: Done!");
});

test("SseParser accumulates split content deltas and multi-chunk tool_calls", () => {
  const deltas = [];
  const parser = new streamMod.SseParser((d) => deltas.push(d));

  parser.feed('data: {"choices":[{"delta":{"content":"Check"}}]}\n\n');
  parser.feed('data: {"choices":[{"delta":{"content":"ing ops."}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":"{\\"chan"}}]}}]}\n\n');
  parser.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"channel","arguments":"nel\\":\\"ops\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
  parser.feed("data: [DONE]\n\n");

  const res = parser.finish();
  assert.equal(deltas.join(""), "Checking ops.");
  assert.equal(res.content, "Checking ops.");
  assert.equal(res.finishReason, "tool_calls");
  assert.deepEqual(res.toolCalls, [{ id: "call_1", name: "read_channel", arguments: '{"channel":"ops"}' }]);
});

test("SseParser falls back cleanly on non-streaming JSON responses", () => {
  const deltas = [];
  const parser = new streamMod.SseParser((d) => deltas.push(d));
  parser.feed(JSON.stringify({ choices: [{ message: { content: "All clear in ops." }, finish_reason: "stop" }] }));
  const res = parser.finish();
  assert.equal(res.content, "All clear in ops.");
  assert.deepEqual(deltas, ["All clear in ops."]);
  assert.deepEqual(res.toolCalls, []);
});

test("runAgentTurn streams ack, executes tool, and streams final answer", async () => {
  let callNum = 0;
  const host = {
    async spawn(id, opts) {
      assert.equal(id, "llm");
      assert.ok(opts.args.includes("-N"), "expected curl -N for SSE streaming");
      const n = ++callNum;
      return {
        async write() {},
        async end() {
          if (n === 1) {
            opts.onStdout('data: {"choices":[{"delta":{"content":"Checking ops. "}}]}\n\n');
            opts.onStdout(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_channel","arguments":"{\\"channel\\":\\"ops\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            );
            opts.onStdout("data: [DONE]\n\n");
          } else {
            opts.onStdout('data: {"choices":[{"delta":{"content":"Deploy finished green. "}}]}\n\n');
            opts.onStdout('data: {"choices":[{"delta":{"content":"No errors reported."},"finish_reason":"stop"}]}\n\n');
            opts.onStdout("data: [DONE]\n\n");
          }
        },
        async kill() {},
        exited: Promise.resolve(0),
      };
    },
  };

  const spoken = [];
  const activities = [];
  const executed = [];
  const abort = new AbortController();

  const res = await agentMod.runAgentTurn({
    host,
    settings: { ...engineMod.DEFAULT_SETTINGS, llmUrl: "http://localhost:4000/v1", llmModel: "test" },
    history: [{ role: "user", content: "How is ops?" }],
    context: () => ({
      channels: [{ name: "ops", description: "Deployments" }],
      people: ["build-bot"],
      scopeSummary: "",
      pendingSummary: "",
      watchesSummary: "",
      confirmBeforeSend: true,
    }),
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return { result: "build-bot: Deploy #42 succeeded." };
    },
    onActivity: (label) => activities.push(label),
    onTextUpdate: () => {},
    onSpeak: (s) => spoken.push(s),
    signal: abort.signal,
  });

  assert.equal(res.aborted, false);
  assert.deepEqual(executed, [{ name: "read_channel", args: { channel: "ops" } }]);
  assert.ok(activities.includes("Reading #ops..."));
  assert.deepEqual(spoken, ["Checking ops.", "Deploy finished green.", "No errors reported."]);
});

test("runAgentTurn aborts immediately on barge-in signal and kills curl process", async () => {
  let killed = false;
  let resolveExit;
  const abort = new AbortController();

  const host = {
    async spawn(_id, opts) {
      return {
        async write() {},
        async end() {
          opts.onStdout('data: {"choices":[{"delta":{"content":"Starting a very long explanation. "}}]}\n\n');
          abort.abort();
        },
        async kill() {
          killed = true;
          resolveExit(137);
        },
        exited: new Promise((r) => {
          resolveExit = r;
        }),
      };
    },
  };

  const spoken = [];
  const res = await agentMod.runAgentTurn({
    host,
    settings: { ...engineMod.DEFAULT_SETTINGS, llmUrl: "http://localhost:4000/v1", llmModel: "test" },
    history: [{ role: "user", content: "Explain everything" }],
    context: () => ({
      channels: [],
      people: [],
      scopeSummary: "",
      pendingSummary: "",
      watchesSummary: "",
      confirmBeforeSend: true,
    }),
    executeTool: async () => ({ result: "" }),
    onActivity: () => {},
    onTextUpdate: () => {},
    onSpeak: (s) => spoken.push(s),
    signal: abort.signal,
  });

  assert.equal(killed, true);
  assert.equal(res.aborted, true);
  assert.deepEqual(spoken, ["Starting a very long explanation."]);
});

test("Controller uses session.observe for instant watched-thread replies", async () => {
  let obsListener = null;
  let observedEvents = [];
  const spokenTexts = [];

  const fakeRelay = {
    pubkey: "owner_pk",
    channels: () => [{ id: "ch1", name: "ops", members: ["owner_pk", "bot_pk"] }],
    profiles: async () => new Map([["bot_pk", "build-bot"]]),
    session: {
      channels: {
        list: () => ({ status: "ready", channels: [{ id: "ch1", name: "ops", members: ["owner_pk", "bot_pk"] }] }),
        subscribeList: () => () => {},
        ensureList: () => {},
      },
      profiles: {
        snapshot: () => new Map([["bot_pk", { name: "build-bot" }]]),
        subscribe: () => () => {},
        ensure: async () => {},
      },
      observe: () => ({
        snapshot: () => ({ status: "ready", events: observedEvents }),
        subscribe: (fn) => {
          obsListener = fn;
          return () => {
            obsListener = null;
          };
        },
        refresh: async () => {},
        dispose: () => {},
      }),
    },
  };

  const host = {
    async spawn(id, opts) {
      if (id === "tts-say") {
        // capture spoken text and fail gracefully without OS say in Linux test env
        return {
          async write() {},
          async end(text) {
            if (text) spokenTexts.push(text);
          },
          async kill() {},
          exited: Promise.resolve(127),
        };
      }
      if (id === "say") {
        return {
          async write() {},
          async end() {},
          async kill() {},
          exited: Promise.resolve(127),
        };
      }
      if (id === "setup") {
        return {
          async write() {},
          async end() {
            opts.onStdout?.('{"engine":true,"model":true,"buzzVoice":null}\n');
          },
          async kill() {},
          exited: Promise.resolve(0),
        };
      }
      if (id === "runtime") {
        return {
          async write() {},
          async end() {
            opts.onStdout?.('{"runtime":true}\n');
          },
          async kill() {},
          exited: Promise.resolve(0),
        };
      }
      if (id === "tts-setup") {
        return {
          async write() {},
          async end() {
            opts.onStdout?.('{"ttsModel":false}\n');
          },
          async kill() {},
          exited: Promise.resolve(0),
        };
      }
      return {
        async write() {},
        async end() {},
        async kill() {},
        exited: Promise.resolve(0),
      };
    },
  };

  const controller = new controllerMod.Controller({
    host,
    relay: () => fakeRelay,
    decide: () => null,
    community: () => undefined,
  });
  const stop = controller.start();

  controller.watch({
    rootId: "root123",
    channelId: "ch1",
    channelName: "ops",
    label: "Deploy check",
    since: 1000,
  });

  assert.ok(obsListener, "expected live session.observe subscription to be registered");

  observedEvents = [
    {
      id: "reply1",
      pubkey: "bot_pk",
      created_at: 1005,
      kind: 9,
      content: "Deploy finished cleanly.",
      tags: [
        ["h", "ch1"],
        ["e", "root123", "", "root"],
      ],
    },
  ];
  obsListener();
  await new Promise((r) => setTimeout(r, 30));

  const snap = controller.snapshot();
  assert.ok(snap.log.some((e) => e.text === "Deploy finished cleanly." && e.meta === "build-bot in ops"));
  assert.ok(snap.scope.includes("ops"), `expected incoming reply to set focus scope, got "${snap.scope}"`);
  assert.ok(spokenTexts.some((t) => t.includes("build-bot in ops")));
  stop();
});

test("manifest.json declares all host processes and respects the 1024-byte arg limit", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const ids = new Set(manifest.host.processes.map((p) => p.id));
  for (const expected of ["stt", "stt-http", "setup", "runtime", "listen", "say", "tts-say", "tts-http", "tts-local", "tts-setup", "llm"]) {
    assert.ok(ids.has(expected), `missing host process ${expected}`);
  }
  for (const proc of manifest.host.processes) {
    for (const arg of proc.args ?? []) {
      assert.ok(Buffer.byteLength(arg, "utf8") <= 1024, `arg in ${proc.id} exceeds 1024 bytes`);
    }
  }
});

test("Controller.interrupt aborts an in-flight streaming LLM turn cleanly", async () => {
  let killed = false;
  let resolveExit;
  const fakeRelay = {
    pubkey: "owner_pk",
    channels: () => [{ id: "ch1", name: "ops", members: ["owner_pk"] }],
    profiles: async () => new Map(),
    session: {
      channels: { list: () => ({ status: "ready", channels: [] }), subscribeList: () => () => {}, ensureList: () => {} },
      profiles: { snapshot: () => new Map(), subscribe: () => () => {}, ensure: async () => {} },
      observe: () => ({ snapshot: () => ({ status: "ready", events: [] }), subscribe: () => () => {}, refresh: async () => {}, dispose: () => {} }),
    },
  };
  const host = {
    async spawn(id, opts) {
      if (id === "llm") {
        return {
          async write() {},
          async end() {
            opts.onStdout?.('data: {"choices":[{"delta":{"content":"Working on that... "}}]}\n\n');
          },
          async kill() {
            killed = true;
            resolveExit(137);
          },
          exited: new Promise((r) => {
            resolveExit = r;
          }),
        };
      }
      return {
        async write() {},
        async end() {
          if (id === "setup") opts.onStdout?.('{"engine":true,"model":true,"buzzVoice":null}\n');
          if (id === "runtime") opts.onStdout?.('{"runtime":true}\n');
          if (id === "tts-setup") opts.onStdout?.('{"ttsModel":false}\n');
        },
        async kill() {},
        exited: Promise.resolve(id === "tts-say" || id === "say" ? 127 : 0),
      };
    },
  };
  const controller = new controllerMod.Controller({
    host,
    relay: () => fakeRelay,
    decide: () => null,
    community: () => undefined,
  });
  const stop = controller.start();
  controller.updateSettings({ llmUrl: "http://localhost:4000/v1", llmModel: "test", speak: false });

  const turnPromise = controller.handleTranscript("Tell me a long story");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(controller.snapshot().busy, true);

  controller.interrupt(false);
  await turnPromise;

  assert.equal(killed, true);
  assert.equal(controller.snapshot().busy, false);
  stop();
});
