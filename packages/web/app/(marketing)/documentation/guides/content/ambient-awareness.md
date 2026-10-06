Stable mode injects a feed of recent sessions into every new session at start. The agent's first context window already contains what the team worked on recently: session IDs, titles, work states, message counts, and the opening lines of each conversation. Paired with [messaging](/documentation/messaging), this gives a fleet of sessions ambient awareness of each other: every session knows its neighbors exist, what state they are in, and how to reach them.

Stable mode is enabled through the [snippet system](/documentation/agent-snippets)'s wizard, or directly:

```bash
cast install stable      # enable (solo)
cast stable team         # switch mode
cast install stable --disable
```

## Solo, team, off

Stable is a three-way choice, not a toggle:

| Mode | Lookback | Items | Framed as |
|------|----------|-------|-----------|
| `solo` | 7 days | 10 | what you have been working on |
| `team` | 14 days | 15 | what the team has been working on |
| `off` | | | nothing injected |

Both modes read the same feed: the sessions you can see in the current project, which in a project shared with a team includes teammates' sessions with their names attached. Solo is the shorter, more personal view; team reaches further back, so a fresh session starts knowing that a colleague's agent is mid-flight on the same subsystem before it duplicates the work. A global flag (`-g`) widens either mode from the current project to every project you can see.

```figure
FeedWindowFigure
Solo keeps up to 10 sessions from the last week, team up to 15 from the last two; an excluded session's place goes to the next one.
```

## How injection works

Every agent gets the block from a single builder, so the feed parameters and format can never drift. What differs is how each agent receives it:

- **Claude Code**: `cast install stable` registers `cast stable-context` as a SessionStart hook. When a session boots, the hook fetches the feed and prints a `<stable-context>` block that Claude Code folds into the opening context.
- **Codex**: when the daemon starts a Codex thread, it builds the same block and passes it as developer instructions. Codex sessions started outside the daemon get it from a SessionStart hook of their own.
- **Cursor, opencode and Grok** each have a path of their own, with the same block.

```figure
InjectionPathsFigure
One builder serves every agent; the block is recorded for the web, and any failure means the session simply starts without it.
```

The injected block looks like this:

```
<stable-context mode="team">
This gives you bigger-picture visibility on what has been and is
being worked on by the team.

── Session binding Convex error ────────────────────
   jx7az96 | ● needs input | 41 min ago | 408 msgs | ~/src/codecast
     1: [user] …first line of the conversation…
     2: [assistant] …first reply…
…
Use: cast read jx7az96 <range>    # read messages by line range
</stable-context>
```

Each entry carries the session's short ID, so the agent can immediately `cast read` any of them for detail, or `cast send` one a message. The feed is oriented toward action, not decoration: "needs input" means the ball is in someone's court, "working" means an agent is mid-flight, and the agent reading the feed is expected to use that.

## Recorded, visible, failure-safe

What was injected is recorded against the conversation, and the web renders it as cards at the top of the transcript, so a human reading the session later sees exactly which sessions the agent knew about at boot.

A session started from the web gets a preview before it starts: the new-session screen shows the cards the hook will inject, lets you switch the mode for this one session (Auto follows the machine's setting), and lets you drop individual sessions from its feed.

![A conversation whose top shows five session cards it started with, above a new-session screen previewing the cards it will inject with an Auto, Team, Solo, Off switch](/documentation/ambient-awareness/stable-context.webp "Top: the cards a session started with, expanded. Bottom: a new session's preview, with the mode switch for this session.")

Injection is an enhancement, never a boot blocker. The fetch gives up after 15 seconds, and any failure (network down, backend unhealthy, not authenticated) means the session simply starts without the block. Sessions dropped in the preview are excluded from the feed, and the fetch over-fetches by the exclusion count so the feed never shrinks below its normal size.

## Why this changes fleet behavior

Without stable mode, a session knows only what its prompt says. Coordination has to be pushed: someone (human or orchestrator) must tell each worker about the others. With stable mode, coordination can be pulled: any session can notice a neighbor in the feed, read its transcript, and message it. The [messaging guide](/documentation/messaging) shows the patterns this enables: delegation, peer collaboration, and fleets where workers find each other by label. Awareness comes from the feed; action comes from `cast send`.
