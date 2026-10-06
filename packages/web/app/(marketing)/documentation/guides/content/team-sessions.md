Every Claude Code session your team runs already writes a complete transcript to disk: Claude Code keeps JSONL history files under `~/.claude/projects/`, and Codex, Cursor, OpenCode, pi, Grok and Gemini keep equivalents of their own. The sessions are recorded; they just aren't anywhere anyone can see them. Codecast turns those files into one live dashboard for the whole team.

## The mechanics

Each teammate runs the installer once:

```bash
curl -fsSL https://codecast.sh/install | sh
cast login
```

That starts a local daemon that watches the agents' own history files and syncs each conversation to your team's workspace as it happens, with no change to how anyone runs their agents. A session started in a terminal, tmux, an IDE terminal, or over SSH is picked up the same way, because the daemon reads what the agent writes, not how it was launched.

```figure
DaemonSyncFigure
The agents keep writing their own history files. The daemon reads them as they grow, and each line reaches the team's workspace live.
```

From then on, two surfaces answer the question this page is named for:

- **The feed** (`codecast.sh/feed`): every team-visible session, newest first, across all machines and agents. Who is working on what, right now and historically.
- **The inbox** (`codecast.sh/inbox`): the same sessions sorted by who acts next: needs input, done, working. A session stuck on a permission prompt surfaces at the top, and you can answer it from the web, the desktop app, or the iOS app.

```figure
FeedInboxFigure
One set of sessions, two orders: the feed by recency, the inbox by who has to act.
```

Opening any session shows the full conversation live (messages, tool calls, diffs) and you can type into it from there, so "looking at a teammate's stuck session" and "unblocking it" are the same motion.

![A teammate's session open beside the inbox](/documentation/shots/conversation.webp "Retry failed webhooks, open live: the agent's edit to src/billing/retry.ts as a diff, the test run, and a reply being typed into the composer.")

## What "team-visible" means

Visibility is per directory, not all-or-nothing. Each repo path maps to a team (or stays private); a session inherits the mapping of the directory it runs in, and the longest matching path wins. A mapping also remembers the repository it was made for, so a clone or worktree of that repository outside the folder (Codex keeps its worktrees under `~/.codex`) follows the same rule. A share applies from the day you turn it on, so sessions from before it stay private. Work in `~/src/product` can be team-visible while `~/personal/experiments` stays yours: same daemon, same account. Sessions can also be shared individually by link.

```figure
VisibilityRuleFigure
The server resolves each session once, when it is created. Anything no rule covers stays private.
```

## Beyond watching

Because every session lands in one place, the record compounds:

- `cast search "auth refactor"`: full-text search across every past session on the team.
- `cast ask "how did we fix the flaky deploy?"`: ask questions across that history.
- `cast blame src/api.ts:120`: trace a line of code to the conversation that wrote it.
- Agents themselves get the same access (see [Agent memory](/documentation/memory)), so a fresh session can consult what any teammate's agent already solved.

## Scope of the answer

Codecast's dashboard covers Claude Code, Codex CLI, Cursor, OpenCode, pi, Grok and Gemini sessions on any machine a teammate runs the daemon on. If you need usage analytics (spend, acceptance rates, seat activity), Anthropic's own analytics dashboard (claude.ai/analytics) is the right tool. Codecast is about the sessions themselves: seeing them, steering them, and remembering them.
