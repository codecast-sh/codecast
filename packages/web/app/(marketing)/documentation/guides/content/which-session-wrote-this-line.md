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

It works in three steps. Git does the line history locally, exactly as `git blame --porcelain` would. Codecast then resolves each commit to the session that made it: first by the commit's `Codecast-Session` trailer (below), then by commit hash, then by commit subject and time when the hash no longer matches. Lines that are not committed yet are matched by their content against your recent agent edits. When both apply, the session that wrote the line wins over the session that committed it, and a line no session touched keeps its ordinary git author.

The output matches git blame's default and porcelain formats, so editor integrations that shell out to `git blame` can call `cast blame` instead. Porcelain output carries the attribution as extra `codecast-session`, `codecast-title`, `codecast-url` and `codecast-message` keys, which porcelain parsers ignore. For vim, `cast blame --install-fugitive` makes `:Gblame` show sessions, and `cast blame --log src/auth.ts` lists the sessions that shaped a file, newest first.

Nothing has to be installed in the repository. The attribution comes from sessions the codecast daemon already recorded, which is also its limit: it covers work done while the daemon was running, in agents codecast records (Claude Code, Codex, Cursor and Gemini), and reading it needs a codecast account with access to those sessions.

## The `Codecast-Session` trailer

Every commit a Claude Code session makes carries a link to that session in its message:

```
fix: refresh the token before it expires

Codecast-Session: https://codecast.sh/conversation/jx74qbm2d0x6yhk3rb8e1nqz5f7aw9tc
```

Codecast's hooks add it by rewriting each `git commit` the agent runs to `git commit --trailer 'Codecast-Session: …'`, without touching the permission decision. Because the link lives in the commit message, it survives rebases, squash merges and any git host, `git log` alone leads back to the conversation, and `cast blame` and the team feed use it before any guess. Opening the link still needs access to the session: the trailer names it, it does not share it. A trailer naming a session outside the commit's own team is ignored.

It covers `git commit` as Claude Code runs it, including `-m`, `-F`, `-am`, `--amend`, heredoc messages and commits inside compound commands. It does not cover commits made by a script the agent runs, a git alias, `git merge` or `git rebase`, or other agents: Codex can only rewrite a command by approving it too, so codecast leaves it alone there. To turn it off:

```bash
git config codecast.sessionTrailer false   # in one repository
cast config session_trailer false          # everywhere on this machine
export CODECAST_SESSION_TRAILER=0          # in the environment an agent starts from
```

## With a dedicated attribution tool

Two open source tools solve the same question from the other direction, by writing attribution into the repository itself.

**[Git AI](https://usegitai.com/agent-blame)** stores attribution in git notes, captured through hooks in the agents while they work, so it has to be installed before the code is written. It supports twelve agents, including Claude Code, Codex, Cursor, Copilot and Gemini CLI, rewrites its attributions through rebases, squashes and cherry picks, and keeps the prompts behind each line.

**[Agent Blame](https://www.mesa.dev/blog/agentblame-deep-dive)**, from Mesa, also writes git notes: it captures edits from Cursor, Claude Code and OpenCode and matches them to new lines in a post commit hook. Each attributed line shows the tool, the model, and a confidence score; it does not record prompts.

Because both keep the record in git notes, the attribution travels with the code and anyone with a clone can read it, with no service involved.

## Choosing

Choose Git AI or Agent Blame when the attribution has to live in the repository: readable by anyone who clones it, auditable without an account, and you can install hooks before the work starts. Choose `cast blame` when you want the whole conversation behind a line rather than a label, when the code was written before anyone installed anything, or when your team already records its sessions in codecast. Its trailer puts the link in the repository too, though reading the conversation behind it still needs access in codecast. They do not conflict: git notes written by either tool sit alongside git history that `cast blame` reads.
