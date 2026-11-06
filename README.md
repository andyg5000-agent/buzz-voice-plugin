# Buzz Voice plugin

Talk to Buzz from inside the Buzz desktop app, the way the standalone Buzz Voice
app works.

- **Talk.** Hold the button (or tap to latch, or press Cmd+Shift+Space anywhere
  in Buzz) and say what you want: "in ops tell build-bot to rerun the deploy",
  "how is the deploy going in ops", "what is in my inbox". A task comes back as
  an editable card with the channel, thread and who it notifies; say "yes" or
  press Enter to send. Questions are read back out loud. Threads you post to or
  ask about are watched for eight hours and new replies are read out as they
  land. You can also type instead of talking.
- **Flags.** Every thread that carries a reaction, grouped by emoji with counts,
  for everyone or just yours. Open a thread in Buzz or follow it.

## What runs where

- Speech to text runs on your machine with sherpa-onnx and the whisper
  `small.en` model, the same engine and model folder (`~/buzz-voice-models`) the
  standalone app uses. Audio never leaves the machine. If the engine or model is
  missing, the page offers an install button that downloads them from the
  sherpa-onnx GitHub releases.
- Routing (which channel, thread and person) uses the Decisions API provider
  chosen in Buzz Settings when one is on, and falls back to the language model.
- The language model writes the message body and reads channels back. Any
  OpenAI-compatible endpoint works, http or https, set under Settings > Buzz
  Voice. If the standalone app is installed its endpoint is picked up
  automatically.
- Posting and reading go through your signed-in Buzz session. No keys are
  stored by the plugin.
- Replies are spoken with the macOS `say` voice.

## Host access it asks for

| Process | Why |
| --- | --- |
| `sh` (stt) | Decode the recorded audio with the local sherpa-onnx engine |
| `sh` (setup) | Check for, or download, the engine and model |
| `say` | Speak replies |
| `curl` (llm) | Call your language model, including plain http on a LAN |

The scripts are in `scripts/` and embedded verbatim in `manifest.json`.

## Install

Settings > Plugins > Manage plugins > Add, then import from Git:
`https://github.com/andyg5000-agent/buzz-voice-plugin.git`, branch `main`.

## Build

`plugin.js` and `manifest.json` are generated. Edit `src/` or `scripts/`, then:

```bash
npm install
npm run check
npm run build
```
