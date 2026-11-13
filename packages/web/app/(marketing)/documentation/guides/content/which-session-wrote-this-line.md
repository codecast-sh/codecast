`git blame` tells you who committed a line. When an agent wrote it, that is only the person who ran the agent, and the reasoning is gone: the request that asked for it, the alternatives it rejected, the test that settled it. Codecast keeps that reasoning. For any line an agent wrote while codecast was running, you can see which session wrote it and open the conversation.

![A file in the Code view with Blame set to Sessions: a strip reading "94% by 3 sessions" with a chip per session, and the session behind each block of lines in the gutter](/documentation/which-session-wrote-this-line/session-blame.webp "Blame set to Sessions. The strip lists the sessions that wrote the file; the gutter names the one behind each block.")

## Turn on session blame

1. Open **Code** in the sidebar, then a repository and a file.
2. In the bar above the file, set **Blame** to **Sessions**. Press **B** to cycle Off, Git and Sessions.

**Git** shows ordinary blame, with commits and authors, when that is what you need.

## Read the gutter

The gutter names the session behind each block of lines, with how long ago it was written. A block a person wrote outside any session shows their git name instead, like ordinary blame. Hover a block to see who ran the session, the commit, and how codecast traced the line to it.

## Use the session strip

The strip above the file sums it up: how much of the file traces to a session ("94% by 3 sessions"), then a chip per session with its title, who ran it and how many lines it wrote.

- **Hover a chip** to light up that session's lines wherever they are in the file.
- **Click a chip** to keep them lit and jump to the first one.
- **Click the speech bubble** at the end of a chip to open the conversation. A lock in its place means the session is private to someone else: you can see that it exists, not read it.

![The session strip with one chip hovered and its lines highlighted down the file](/documentation/which-session-wrote-this-line/chip-hover.webp "Hovering a chip lights up every line that session wrote.")

## Ask your agent why

You don't have to open the Code view. Ask an agent with [Memory](/documentation/memory) on:

- "Why does line 42 of src/webhooks.ts wait before retrying?"
- "Which session added the retry cap in the webhook handler, and what was the reason?"
- "Who changed the session timeout last, and did they mean to?"

The agent finds the session that wrote the line, reads the part of the conversation where it was decided, and answers from the author's own reasoning, with a link to that message.

## The session link in each commit

When an agent session commits, codecast adds a last line to the commit message that links back to the session, such as `Codecast-Session: https://codecast.sh/conversation/jx74qbm…`. Because the link is part of the commit message, it survives rebases, squash merges and any git host, and anyone reading `git log` can follow it.

In codecast, a commit page and a pull request's commit list show that line as the session's name, which you click to open the conversation.

![A commit page in codecast showing the session that made the commit by name](/documentation/which-session-wrote-this-line/commit-session.webp "A commit page names the session behind the commit.")

Following the link still needs access to the session: it points at the conversation, it doesn't share it. Codecast adds the line only for sessions shared with your team, so a private session never leaves a link in a shared history. It covers commits Claude Code makes directly; commits made by a script the agent runs, or by other agents, don't get the line, and codecast traces those from its own record of the session's edits instead.

## What it covers

- **Work done while codecast was running**, in the agents it records: Claude Code, Codex, Cursor and Gemini. Code written before you installed codecast keeps its ordinary git blame.
- **Only what you can see.** A session shows by name only if you can open it; otherwise you see a lock.
- **Committed lines.** The Code view shows a branch as it is on your git host.

## Other tools

[Git AI](https://usegitai.com/agent-blame) and [Agent Blame](https://www.mesa.dev/blog/agentblame-deep-dive) write attribution into the repository itself as git notes, captured by hooks installed before the code is written. Anyone with a clone can read it, with no account. Choose them when attribution has to live in the repository; choose codecast when you want the whole conversation behind a line, or when the code was written before anyone installed anything. They work side by side.

## For agents and scripts

`cast blame <file>` prints the same session attribution in a terminal, and is what agents use to answer "why is this line here".
