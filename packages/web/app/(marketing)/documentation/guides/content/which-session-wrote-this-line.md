`git blame` tells you who committed a line. When an agent wrote it, that answer is the person who ran the agent, and the reasoning behind the line is gone: the conversation where it was decided, the alternatives that were rejected, the prompt that asked for it. This guide covers how to get that back, with codecast and with the two tools built specifically for it.

## With codecast: `cast blame`

`cast blame` is a drop in replacement for `git blame` whose author column names the codecast session that wrote each line:

```bash
cast blame src/auth.ts             # every line, with sessions
cast blame src/auth.ts:42          # one line
cast blame -L 10,30 src/auth.ts    # a range
cast blame --open src/auth.ts:42   # open the conversation behind line 42
```

In place of an author name, a line shows the session's short id, the first name of the person who ran it, and the session's title, for example `jx74qbm Samvit Agent prompt guardrails`. `--open` goes further: when codecast knows the message that made the edit, it opens the conversation scrolled to that message; otherwise it opens the session.

It works in three steps. Git does the line history locally, exactly as `git blame --porcelain` would. Codecast then resolves each commit to the session that made it, by commit hash, or by commit subject and time when the hash no longer matches. Lines that are not committed yet are matched by their content against your recent agent edits. When both apply, the session that wrote the line wins over the session that committed it, and a line no session touched keeps its ordinary git author.

The output matches git blame's default and porcelain formats, so editor integrations that shell out to `git blame` can call `cast blame` instead. Porcelain output carries the attribution as extra `codecast-session`, `codecast-title`, `codecast-url` and `codecast-message` keys, which porcelain parsers ignore. For vim, `cast blame --install-fugitive` makes `:Gblame` show sessions, and `cast blame --log src/auth.ts` lists the sessions that shaped a file, newest first.

Nothing has to be installed in the repository and nothing runs at commit time. The attribution comes from sessions the codecast daemon already recorded, which is also its limit: it covers work done while the daemon was running, in agents codecast records (Claude Code, Codex, Cursor and Gemini), and reading it needs a codecast account with access to those sessions. A stranger who clones the repository sees plain git history.

## With a dedicated attribution tool

Two open source tools solve the same question from the other direction, by writing attribution into the repository itself.

**[Git AI](https://usegitai.com/agent-blame)** stores attribution in git notes, captured through hooks in the agents while they work, so it has to be installed before the code is written. It supports twelve agents, including Claude Code, Codex, Cursor, Copilot and Gemini CLI, rewrites its attributions through rebases, squashes and cherry picks, and keeps the prompts behind each line.

**[Agent Blame](https://www.mesa.dev/blog/agentblame-deep-dive)**, from Mesa, also writes git notes: it captures edits from Cursor, Claude Code and OpenCode and matches them to new lines in a post commit hook. Each attributed line shows the tool, the model, and a confidence score; it does not record prompts.

Because both keep the record in git notes, the attribution travels with the code and anyone with a clone can read it, with no service involved.

## Choosing

Choose Git AI or Agent Blame when the attribution has to live in the repository: readable by anyone who clones it, auditable without an account, and you can install hooks before the work starts. Choose `cast blame` when you want the whole conversation behind a line rather than a label, when the code was written before anyone installed anything, or when your team already records its sessions in codecast. They do not conflict: git notes written by either tool sit alongside git history that `cast blame` reads.
