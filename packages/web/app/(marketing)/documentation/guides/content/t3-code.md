T3 Code is an open source app for starting and steering coding agents on your own machine. A thread you start in T3 Code shows up in Codecast like any other session, with no setup. T3 Code drives the agents' own harnesses, those keep their transcripts on disk, and Codecast already reads them there.

We checked this on October 12, 2026 with two threads started in the T3 Code desktop app, one on Claude and one on Codex. Both appeared in Codecast, the Claude one within about a minute.

![A thread in T3 Code: a request to add retry backoff to the webhook sender, Claude's answer and two changed files](/documentation/t3-code/t3-thread.webp "A thread started in T3 Code, running Claude.")

![The same session in Codecast, with the request, Claude's steps and a 2 files changed chip](/documentation/t3-code/codecast-session.webp "The same thread in Codecast a minute later. Nothing was installed into T3 Code to get it there.")

## Set it up

1. Install Codecast on the machine where T3 Code runs its agents and sign in ([Download](/download)). If you reach that machine from your phone through T3 Code's remote access, this is the host machine, not the phone.
2. Keep using T3 Code as you do now.

There is no plugin and no setting to change in T3 Code. Threads you already ran come in too, since their transcripts are still on disk.

## What you get on top of T3 Code

- **Everything else you run, in the same place.** T3 Code shows the threads it launched, plus a one time import of recent Claude and Codex sessions when you first set it up. Codecast keeps syncing every session you start in a terminal, an editor or a script, beside your T3 Code threads, on every machine.
- **Your team can see the work.** T3 Code shows your own machines. Share the repository with a Codecast team and teammates can read the thread, live or afterwards, at the level you choose: hidden, a summary, or the full conversation. [Team sessions](/documentation/team-sessions) covers the settings.
- **One search box over everything.** T3 Code threads sit beside the sessions you ran in a terminal, in Cursor or on another machine. See [Search sessions across machines](/documentation/search-sessions-across-machines).
- **Agents can read the history.** An agent starting new work can look up what an earlier thread decided, wherever you ran it. See [Memory](/documentation/memory).
- **A link for any thread.** Share a whole session or a few messages with someone who does not have T3 Code. See [Share a session](/documentation/share-a-session).
- **Code traced to its conversation.** Find [which session wrote a line](/documentation/which-session-wrote-this-line), including lines a T3 Code thread wrote.

## What stays in T3 Code

Keep steering the thread in T3 Code. It owns the running agent, so follow ups, approvals, the branch or worktree and the pull request button belong there. Treat Codecast as the record and the team's view, and send your next message from T3 Code.

Codecast reads the history of Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok and Muse Spark. We have checked Claude and Codex threads started in T3 Code; threads on its other providers are untested, and Antigravity threads are not picked up.

## Which one should I use?

Both, if you like T3 Code's window. T3 Code is a place to start threads. Codecast is the record of every session you run, wherever it started, with search, steering from any device, forks, triggers and a team layer when you want one. [Codecast vs T3 Code](/compare/codecast-vs-t3-code) lays the two side by side.
