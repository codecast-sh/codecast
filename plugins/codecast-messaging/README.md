# codecast-messaging

A Claude Code plugin that makes Claude sessions started from [herdr](https://herdr.dev) or paseo addressable by other agents through `cast send`, without the rest of codecast. Nothing reads or uploads the session's transcript, and codecast never starts or resumes Claude itself. Design and discussion: [#102](https://github.com/codecast-sh/codecast/issues/102).

## What it does

- **Session start**: registers the session with codecast (`cast register`), with the herdr pane or paseo agent it runs in, and starts `cast relay` in the background if it is not running.
- **Session end**: marks the session ended (`cast unregister`). Messages still queued for it go back to their senders.
- **`cast relay`** delivers each message into the session's herdr pane (herdr's `agent.prompt`) or paseo agent (`paseo send --behavior steer`), wrapped in `<<<<<<` / `>>>>>>` markers.
- **A skill** teaches the agent `cast feed`, `cast send`, `cast rename` and `cast state`.

A session started outside herdr and paseo is not registered.

The plugin does nothing unless the machine is messaging-only (`cast config messaging_only true`). On a machine running full codecast, `cast register` and `cast relay` exit without registering anything, so the daemon's own sync is never disturbed.

## Setup

1. Install the `cast` CLI.
2. Mark the machine messaging-only, so no `cast` command starts the full codecast daemon or writes hooks into `~/.claude`:

   ```bash
   cast config messaging_only true
   ```

3. Sign in with `cast auth`. On a machine with no browser, use `cast login <setup token>`. Signing in on a messaging-only machine writes the sign-in and nothing else: no daemon, no history import, nothing in `~/.claude`.
4. In Claude Code:

   ```
   /plugin marketplace add codecast-sh/codecast
   /plugin install codecast-messaging@codecast
   ```

A machine that already ran full codecast runs `cast uninstall --keep-config` first. It stops the daemon, removes auto-start, the hooks codecast wrote into `~/.claude/settings.json`, its slash command, skills and CLAUDE.md sections, and the `codecast` binary and `cast` link under `~/.local/bin`, and it keeps `~/.codecast` (your sign-in and settings). Install `cast` again afterwards, then continue from step 2. Sessions already uploaded stay in codecast.

## Removal

Run `/plugin uninstall codecast-messaging@codecast`, then `cast relay --stop` to stop the background relay. `cast uninstall` stops it too.

## What codecast stores

For each registered session: its id, title, state, folder, git remote, the machine it runs on, its owner, and where to deliver messages (the herdr pane or paseo agent). It also stores the messages sent to the session with `cast send`. It stores no transcript.

Registered sessions are shared with the team that owns their folder, or your active team, unless the folder is locked private.
