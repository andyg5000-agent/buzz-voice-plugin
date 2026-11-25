import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const script = (name) => {
  const text = readFileSync(`scripts/${name}.sh`, "utf8").trim();
  if (Buffer.byteLength(text) > 1024) throw new Error(`scripts/${name}.sh is over the 1024 byte argument limit`);
  return text;
};

const manifest = {
  id: "blueoi.buzz-voice",
  name: "Buzz Voice",
  apiVersion: 1,
  description:
    "Live, reactive voice assistant for Buzz with barge-in, streaming replies, and pluggable LLM, STT, and TTS backends. Talk hands-free or push to talk, manage todos, and find threads by emoji.",
  discovery: { category: "productivity", tags: ["voice", "speech", "emoji"] },
  updates: { defaultEnabled: true },
  host: {
    processes: [
      { id: "stt", program: "sh", args: ["-c", script("stt"), "buzz-voice-stt"] },
      { id: "stt-http", program: "sh", args: ["-c", script("stt-http"), "buzz-voice-stt-http"] },
      { id: "setup", program: "sh", args: ["-c", script("setup"), "buzz-voice-setup"] },
      { id: "runtime", program: "sh", args: ["-c", script("runtime"), "buzz-voice-runtime"] },
      { id: "listen", program: "sh", args: ["-c", script("listen"), "buzz-voice-listen"] },
      { id: "say", program: "say" },
      { id: "tts-say", program: "sh", args: ["-c", script("tts-say"), "buzz-voice-tts-say"] },
      { id: "tts-http", program: "sh", args: ["-c", script("tts-http"), "buzz-voice-tts-http"] },
      { id: "tts-local", program: "sh", args: ["-c", script("tts-local"), "buzz-voice-tts-local"] },
      { id: "tts-setup", program: "sh", args: ["-c", script("tts-setup"), "buzz-voice-tts-setup"] },
      {
        id: "llm",
        program: "curl",
        args: ["-sS", "--max-time", "120", "-H", "Content-Type: application/json", "--data-binary", "@-"],
      },
    ],
  },
};

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "plugin.js",
  loader: { ".py": "text" },
  banner: { js: "// Built from src/ by build.mjs. Edit the TypeScript, then run npm run build." },
});
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
