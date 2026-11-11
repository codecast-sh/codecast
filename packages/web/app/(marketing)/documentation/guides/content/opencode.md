OpenCode is an open source coding agent that runs in your terminal. Codecast records every agent session you run and lets you search, steer and share all of them from the desktop app, the web or your phone, whether you work alone or with a team. Codecast reads OpenCode's own session store, so a session you run in the OpenCode TUI shows up in Codecast with no plugin and no change to your OpenCode setup.

We checked this on November 9, 2026 with OpenCode 1.18.31 on a Mac, using a free model from OpenCode Zen in a small scratch repository. The session appeared in Codecast two seconds after the first prompt was sent, and a follow up typed in the Codecast app ran in OpenCode and came back.

![The OpenCode TUI: a request to fix a slugify function, the edit, a git diff and a node check](/documentation/opencode/opencode-tui.webp "A session in the OpenCode TUI, fixing a one line bug in slugify.js.")

![The same session in Codecast: the request, OpenCode's read, edit and two commands, the diff of line 3 and the answer](/documentation/opencode/codecast-session.webp "The same session in Codecast. The edit shows as a diff, and each command can be opened.")

## Set it up

1. Install Codecast on the machine where you run OpenCode and sign in ([Download](/download)).
2. Keep using OpenCode as you do now.

There is nothing to install into OpenCode and nothing to configure. Codecast reads OpenCode's database at `~/.local/share/opencode/opencode.db` without writing to it, and checks it for changes every two seconds. The first time Codecast runs, it picks up the OpenCode sessions already in that database, so your history from before you installed comes in too.

## What shows up in Codecast

Each OpenCode session becomes one conversation in your inbox, under the folder it ran in, with an OpenCode badge and the model name in its header. Inside it you see your prompts, OpenCode's replies, its reasoning, and every tool call: files read, edits drawn as diffs, and shell commands you can open to see the output. Codecast titles the session from what it was about, and the header counts the files it changed.

## Reply from the app or your phone

Type in the message box at the bottom of an OpenCode conversation and Codecast delivers it to OpenCode on your machine. If no OpenCode process is attached to that session, Codecast starts one in the background (`opencode -s <session id>`), sends your message, and the reply streams back into the conversation.

![The Codecast conversation with a second message sent from the app, "Also trim leading and trailing spaces before slugifying", and OpenCode's edit in reply](/documentation/opencode/codecast-follow-up.webp "The second message was typed in the Codecast app. OpenCode ran it on the laptop and the answer came back within a minute.")

If you still have the OpenCode TUI open on that session in a terminal, it does not redraw with turns sent from Codecast. Reopen the session there with `opencode -s <id>` and they are all in it.

We sent the follow up above from the web app. The phone app sends messages through the same path, but we have not tried it with OpenCode.

## Start an OpenCode session from Codecast

Open **New → Session**, pick the folder, and choose **OpenCode** in the agent menu under the message box. The model menu next to it offers OpenCode's default or a model you pick. Codecast starts OpenCode in that folder on the machine you choose and sends your first message.

![The new session box in Codecast with OpenCode selected as the agent, This checkout, and the machine it will run on](/documentation/opencode/codecast-new-session.webp "OpenCode in the agent menu of a new session.")

We started a session this way and OpenCode did the work in the scratch folder, with its turns synced to Codecast.

## What you get on top of OpenCode

- **Every agent in one inbox.** Your OpenCode sessions sit beside Claude Code, Codex, Cursor, Gemini, pi and Grok sessions, on every machine you use.
- **Search across all of it.** Find the session where something was decided, whichever agent ran it. See [Search sessions across machines](/documentation/search-sessions-across-machines).
- **Context from past sessions.** A new OpenCode session can start with pointers to recent related sessions, so it knows what you were working on. Our test session started with five of them. [Memory](/documentation/memory) explains how agents read earlier sessions.
- **A link for any session.** Share a whole session or a few messages with someone who does not use OpenCode. See [Share a session](/documentation/share-a-session).
- **Code traced to its conversation.** Find [which session wrote a line](/documentation/which-session-wrote-this-line), including lines OpenCode wrote.
- **A team view when you want one.** Put the repository in a Codecast team and teammates can read your OpenCode sessions at the level you choose. [Team sessions](/documentation/team-sessions) covers the privacy settings.

## Fork, switch and hand off

The command palette on any session has **Fork session as…**, **Switch agent…** and **Hand off to…**, and OpenCode is one of the choices. Moving a Claude Code or Codex session to OpenCode creates a new OpenCode session in the same folder and gives it the conversation so far, so OpenCode continues where the other agent stopped. Forking an OpenCode session uses OpenCode's own fork, which needs Codecast to run `opencode serve` in the background; Codecast does that by default when the `opencode` command is installed.

We have not tested fork, switch or hand off with OpenCode for this guide.

## Requirements and limits

- OpenCode 1.2 or newer, which keeps sessions in the SQLite database Codecast reads. Older builds that stored sessions as JSON files are not read.
- Codecast has to run on the machine where OpenCode runs. Sessions on another machine appear when Codecast is installed there too.
- Use OpenCode's own model and provider setup. Codecast does not hold your OpenCode keys.
