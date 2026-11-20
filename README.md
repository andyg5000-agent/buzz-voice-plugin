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
- **Hands-free.** Turn it on (or press Cmd+Shift+H) and say "hey Buzz, ..."
  followed by the command. The end of a sentence is found by voice activity
  detection, so there is nothing to press. After Buzz speaks you have a few
  seconds to answer without the wake word, which is how "yes" confirms a card.
  The microphone is ignored while Buzz is speaking.
- **Todos.** "In ops add a todo for build-bot to rerun the deploy", "mark the
  deploy todo done", "assign the API keys todo to Bob", "what is on the todo
  list in ops". Todos live in the channel Canvas under `## Todos`, the same
  list the Todos panel edits. Assigning someone also mentions them in the
  thread, because an assignment alone does not wake an agent.
- **Flags.** Every thread that carries a reaction, grouped by emoji with counts,
  for everyone or just yours. Open a thread in Buzz, follow it, or use the
  flag button to add or remove your own reactions. The tab, filters and scroll
  position are kept when you leave the page and come back.

## What runs where

- Speech to text runs on your machine with sherpa-onnx and the whisper
  `small.en` model, the same engine and model folder (`~/buzz-voice-models`) the
  standalone app uses. Audio never leaves the machine. If the engine or model is
  missing, the page offers an install button that downloads them from the
  sherpa-onnx GitHub releases.
- Fast speech and hands-free use the sherpa-onnx Python package in a venv in
  the same folder (`venv/`, plus `silero_vad.onnx`). One process keeps whisper
  loaded and runs voice activity detection on the microphone stream, so
  nothing is reloaded per sentence. Install it from Settings; it needs
  `python3`. Without it, push to talk falls back to the one-shot engine.
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
| `sh` (runtime) | Check for, or install, the Python speech runtime and VAD model |
| `sh` (listen) | Run the long-lived recogniser in `scripts/listen.py` |
| `say` | Speak replies |
| `curl` (llm) | Call your language model, including plain http on a LAN |

The shell scripts are in `scripts/` and embedded verbatim in `manifest.json`.
`scripts/listen.py` is bundled into `plugin.js` and passed to the listen
process as its program text.

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
