# Buzz Voice plugin

A live, reactive voice collaborator inside the Buzz desktop app — powered by your own language models and speech systems.

- **Live conversation (`⌘⇧L`).** Natural back-and-forth voice with no wake word, low-latency Silero VAD endpointing, real **barge-in** (talk anytime to interrupt playback and abort the in-flight response), SSE streaming LLM replies, and pipelined sentence-by-sentence WebAudio TTS.
- **Conversational Buzz tools.** Ask about channels, threads, unread mentions, and Canvas todos; draft, refine, and send messages or delegate to agents naturally ("make it shorter and tag opus too", "send it"); flag threads with emoji. Toggle *Confirm before sending* on or off in Settings.
- **Live thread reactivity.** Watched threads subscribe via `session.observe` so agent replies land in under a second, summarize long replies into 1–2 spoken sentences, and automatically put that thread in conversational focus.
- **Talk & Wake-word hands-free.** Push-to-talk (`⌘⇧Space`), wake-word hands-free (`⌘⇧H`, "hey Buzz, ..."), instant stop/interrupt (`⌘⇧.`), and typed commands all remain available. Auto-pauses if you join a native Buzz Huddle.
- **Flags.** Every thread that carries a reaction, grouped by emoji with counts, for everyone or just yours, with a full thread preview beside the list.

## Pluggable models & speech systems

Configure everything under **Settings > Buzz Voice**:

- **Language model:** Any OpenAI-compatible `/v1/chat/completions` endpoint (Ollama, vLLM, LiteLLM, LM Studio, OpenAI, etc.) with streaming SSE + tool calling. Falls back to the Buzz Decisions API when no LLM URL is set.
- **Speech to text (STT):**
  - **Local (`sherpa-onnx` Whisper)** in `~/buzz-voice-models` (offline, default).
  - **OpenAI-compatible `/v1/audio/transcriptions`** (LAN `whisper.cpp`, Speaches / `faster-whisper`, MLX-Whisper, Groq, OpenAI) while keeping local Silero VAD for fast endpointing and barge-in.
- **Text to speech (TTS)** — all rendered through a WebAudio playout queue for echo cancellation and <5 ms interrupt:
  - **System voice** (macOS `say` rendered to 24 kHz WAV -> WebAudio, with fallback to direct `say` / Web Speech).
  - **Local neural TTS (`sherpa-onnx`)** — 1-click install for Kokoro English (`kokoro-en-v0_19`) or Piper Lessac (`vits-piper-en_US-lessac-medium`), kept warm in memory.
  - **OpenAI-compatible `/v1/audio/speech`** (Kokoro-FastAPI, Speaches, Piper HTTP, Orpheus, OpenAI, etc.).

## Host access it asks for

| Process | Why |
| --- | --- |
| `sh` (`stt`, `stt-http`) | Transcribe recorded audio locally (`sherpa-onnx`) or via your OpenAI-compatible STT endpoint |
| `sh` (`setup`, `runtime`, `tts-setup`) | Check for or install `sherpa-onnx`, Whisper, Silero VAD, and local neural TTS models |
| `sh` (`listen`) | Run the long-lived VAD + STT worker (`scripts/listen.py`) |
| `sh` (`tts-local`, `tts-http`, `tts-say`) + `say` | Synthesize speech locally, via your OpenAI-compatible TTS endpoint, or via macOS `say` into WebAudio |
| `curl` (`llm`) | Stream responses from your language model, including plain `http` on a LAN |

The shell scripts live in `scripts/` (each under the 1024-byte host arg limit) and are embedded verbatim in `manifest.json`. `scripts/listen.py` and `scripts/tts.py` are bundled into `plugin.js`.

## Install

Settings > Plugins > Manage plugins > Add, then import from Git:
`https://github.com/andyg5000-agent/buzz-voice-plugin.git`, branch `main`.

## Build & Verify

`plugin.js` and `manifest.json` are generated. Edit `src/` or `scripts/`, then:

```bash
npm install
npm run check
npm run build
npm test
```
