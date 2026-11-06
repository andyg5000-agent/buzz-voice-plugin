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
    "Talk to Buzz: speak a task, confirm it, and it posts to the right channel and thread. Ask how work is going and hear the answer. Find threads by emoji.",
  discovery: { category: "productivity", tags: ["voice", "speech", "emoji"] },
  host: {
    processes: [
      { id: "stt", program: "sh", args: ["-c", script("stt"), "buzz-voice-stt"] },
      { id: "setup", program: "sh", args: ["-c", script("setup"), "buzz-voice-setup"] },
      { id: "say", program: "say" },
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
  banner: { js: "// Built from src/ by build.mjs. Edit the TypeScript, then run npm run build." },
});
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
