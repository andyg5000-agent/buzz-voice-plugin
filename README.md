# Buzz Voice plugin (v0)

A Buzz desktop page with two parts. No voice yet.

- **Find by emoji.** Pick 🔄 working, ⛔ stalled, ✅ done or 👀 needs input and
  see every thread in your channels currently in that state. State follows the
  standalone app: the latest reaction per author wins, then the newest state
  emoji overall. Removed reactions drop out. Open a thread in Buzz, or pick
  Reply here to answer it from this page.
- **Chat with relay.** Pick a channel (the last one used is remembered) and a
  thread, or post a new top-level message. Start a message with `#channel` to
  route it to another channel. Replies in the selected thread show up live.

## Install

Settings > Plugins > Manage plugins > Load from folder, choose this
folder, then enable **Buzz Voice**. The page appears in the sidebar.

`plugin.js` is hand-written, self-contained ESM. There is no build step and no
host access to grant.

## Later

Speech to text, spoken confirmation and read-back will come from a sidecar
process that the plugin talks to, reusing the standalone app's local models.

Or import from Git: `https://github.com/andyg5000-agent/buzz-voice-plugin.git`, branch `main`.
