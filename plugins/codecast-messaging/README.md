# codecast-messaging

A Claude Code plugin that makes Claude sessions started from [herdr](https://herdr.dev) or paseo addressable by other agents through `cast send`, without the rest of codecast. Nothing reads or uploads the session's transcript, and codecast never starts or resumes Claude itself. Design and discussion: [#102](https://github.com/codecast-sh/codecast/issues/102).

## What it does

- **Session start**: registers the session with codecast (`cast register`), with the herdr pane or paseo agent it runs in, and starts `cast relay` in the background if it is not running.
- **Session end**: marks the session ended (`cast unregister`). Messages still queued for it go back to their senders.
- **`cast relay`** delivers each message into the session's herdr pane (herdr's `agent.prompt`) or paseo agent (`paseo send --behavior steer`), wrapped in `<<<<<<` / `>>>>>>` markers.
- **A skill** teaches the agent `cast feed`, `cast send`, `cast rename` and `cast state`.

A session started outside herdr and paseo is not registered.

## Setup

1. Install the `cast` CLI and log in (`cast login`).
2. Mark the machine messaging-only, so no `cast` command starts the full codecast daemon or writes hooks into `~/.claude`:

   ```bash
   cast config messaging_only true
   ```

3. In Claude Code:

   ```
   /plugin marketplace add codecast-sh/codecast
   /plugin install codecast-messaging@codecast
   ```

Remove it with `/plugin uninstall codecast-messaging@codecast`. Registered sessions are shared with the team that owns their folder, or your active team, unless the folder is locked private.
