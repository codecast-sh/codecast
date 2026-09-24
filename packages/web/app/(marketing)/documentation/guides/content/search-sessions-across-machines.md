Claude Code keeps every conversation as a JSONL file under `~/.claude/projects/` on the machine where it ran. That makes search easy on one machine and awkward across several: a session from your laptop is not on your desktop, and a session from a cloud box or a teammate's machine is not on either. This guide covers the options for searching that history, starting with the ones that need nothing installed.

## On one machine

**`claude --resume`** opens a picker of recent sessions for the current project, and the picker can filter the list. It is built in and fine for "the session I had yesterday", but it lists sessions from this machine only.

**[search-sessions](https://github.com/sinzin91/search-sessions)** is a small open source CLI (MIT) that searches the full text of every Claude Code and OpenClaw session in `~/.claude/projects/`, with no index to build and no database. It also installs as a slash command inside Claude Code. It reads local disk only, by design.

**[LLMnesia](https://www.llmnesia.com/blog/search-claude-code-conversation-history)** is a free Chrome and Edge extension that indexes Claude Code sessions from the terminal, the VS Code extension and the desktop app, together with browser chats in ChatGPT, Claude, Gemini and others, into one local search. It also keeps everything on the device, with no account and no cloud.

If all your agent work happens on one computer, one of these is the least setup. Copying `~/.claude/projects/` between machines also works, since Claude Code reads session files wherever they are, but it is a manual step you have to remember each time.

## Across every machine, with codecast

Codecast takes the other approach: instead of searching the files where they sit, a small daemon on each machine watches the history files your agents already write and syncs each conversation to your account as it happens. Every machine that runs the daemon under the same login feeds one history, so a search from any of them, or from the web, covers all of them:

```bash
curl -fsSL https://codecast.sh/install | sh
cast login
```

Search then runs from the terminal:

```bash
cast search "flaky deploy"               # every session you can see, keyword and semantic
cast search auth --mine -s 7d            # only your own sessions, last seven days
cast search "rate limit" -m samvit       # one teammate's sessions
cast search migration -u                 # only what a person typed, not the agent's replies
cast ask "how did we fix the flaky deploy?"   # a question answered across that history
```

Quoted phrases match exactly and unquoted words match anywhere. Each result names its session, which `cast read <id>` opens. The same history is searchable in the web app at `codecast.sh/search`.

Two things differ from the local tools. The search is not only yours: by default it covers every session your team can see for the current directory, and `--mine` narrows it to you. And it covers Codex, Cursor and Gemini sessions alongside Claude Code, because the daemon records those too. Your agents can run the same commands, which is what [Agent memory](/documentation/memory) describes in depth.

The limits are the other side of the design. It only covers machines where the daemon runs, it needs an account, and the history lives in codecast rather than only on your disk. Which directories are shared with a team, and which stay private to you, is set per directory; see [See your whole team's Claude Code sessions in one place](/documentation/team-sessions).

## Choosing

Use `claude --resume` for a recent session on the machine in front of you. Use search-sessions or LLMnesia when you want full text search of your own history and want it to stay on one device. Use codecast when the history you need is spread across several machines or several people, or includes agents other than Claude Code, and you want one place to search it from.
