There are three different things people mean by "share a session", and they have different answers. You want a teammate to read a conversation that already finished. You want someone to watch a session that is running right now. Or you want the whole team's sessions to be visible by default, without anyone deciding to share each one. Work out which one you need first, because the tool that does one badly does another well.

## Read a finished conversation

**Claude Code has this built in**, for sessions that ran in the cloud. Sessions at [claude.ai/code](https://claude.ai/code) carry a visibility toggle: on Team and Enterprise accounts the choice is Private or Team, which makes the session visible to your claude.ai organization; on Pro and Max it is Private or Public, and public means any user signed in to claude.ai can open it. You then send the link. Anthropic's documentation is explicit that the recipient sees the latest state when they open it, and their view does not update live.

Two limits decide whether this covers you. Claude Code on the web is in research preview, for Pro, Max and Team accounts, and for Enterprise accounts with premium seats or Chat and Claude Code seats. And the session has to be a cloud session to appear in that list at all. From the CLI the handoff is one way: `--teleport` pulls a cloud session down to your terminal, and there is no flag that pushes an ordinary terminal session up to the web. The Desktop app's **Continue in** menu can send a local session to the web, so that is the route if you started in your terminal. Check a session for credentials before you make it public; on Pro and Max, repository access verification is off unless you turn it on under Settings, Claude Code, Sharing settings.

**[Lore](https://lore.link/share)** is a dedicated tool for this. You install it as a plugin (`claude plugin marketplace add loredotlink/lore-plugin`) and run `/lore:share` inside Claude Code or Cowork, or `$lore:share` in Codex; it also supports Amp. A thread can be private, visible to your workspace, or public, and a public thread opens without an account. If your need is exactly "turn this conversation into a link a colleague can read", it is the shortest path and it covers agents beyond Claude Code.

## Watch a session that is running

Neither of the above does this. **Remote Control** is Anthropic's answer: run `claude --rc`, or `/rc` inside a session, and the session becomes reachable from claude.ai/code and the Claude mobile app. Execution stays on your machine, and you can answer permission prompts from your phone. It is available on all plans, though on Team and Enterprise an Owner has to turn on the Remote Control toggle in the Claude Code admin settings first.

Remote Control is a live connection to one session, not a record of it. When you want both, see [Codecast vs Claude Code Remote Control](/compare/codecast-vs-claude-code-remote-control).

## Make every session visible without sharing anything

This is what codecast does, and it is a different model rather than a better link. Every supported agent already writes its conversation to disk: Claude Code keeps history files under `~/.claude/projects/`, and Codex, Cursor and Gemini keep their own. The codecast daemon watches those files and syncs each conversation as it happens, so nobody decides to share a session and nobody remembers to start anything:

```bash
curl -fsSL https://codecast.sh/install | sh
cast login
```

From then on `codecast.sh/feed` shows every session the team can see, across machines and across those four agents, and `codecast.sh/inbox` sorts the same sessions by who has to act next. Visibility is set per directory rather than per session, so `~/src/product` can be visible to your team while `~/personal` stays private, on the same account and the same daemon. Individual links still exist when you want one: a conversation or a single message can be shared by link, the same way you would send a Lore thread.

The reason to record everything rather than share on demand is what it makes possible afterwards. `cast search "auth refactor"` searches every past session on the team; `cast ask "how did we fix the flaky deploy?"` asks a question across that history; `cast blame src/api.ts:120` traces a line of code back to the conversation that wrote it. Your agents get the same access, so a new session can consult what a teammate's agent already worked out. See [Agent memory](/documentation/memory).

## Choosing

Use Anthropic's built in sharing if you work in Claude Code on the web and want to send one finished session to a colleague, with nothing to install. Use Lore if you want a dedicated sharing tool for individual conversations and want Codex, Cowork or Amp covered too. Use Remote Control when the session is still running and you want to steer it from your phone. Use codecast when the problem is not any single link, but that your team's sessions are scattered across terminals and machines and none of them survive as something you can search later.

They are not exclusive. Remote Control sessions and sessions started from the Desktop app are ordinary Claude Code sessions on your machine, so a codecast daemon records them like any other.
