A coding agent starts every session knowing nothing about the work that came before it. With Memory on, your agents look things up instead of working them out again: why a function backs off the way it does, what a teammate's session already tried, which session decided on the current design. They search every session you can see, across your machines, your agents and your team, read the parts that matter, and answer with the session they found it in.

![A conversation where the agent looked up why codecast skips the Codecast-Session trailer for private sessions, and answered with the session it was decided in](/documentation/memory/conversation.webp "Asked why a rule exists, the agent searched past sessions, read the one where it was settled, and answered in three sentences. The session it cites is a link: click it to open that conversation.")

## Turn it on

Memory is on by default when you connect a computer to codecast ([Getting started](/documentation#getting-started) covers connecting one). To check, or to switch it off:

1. Open **Agent features** from your account menu and pick the computer.
2. Find **Memory** under *Context*. The switch on its card turns it on or off for that computer.
3. Click **How it works** for what changes and a question to try.

![The Context section of Agent features, with the Stable context and Memory cards](/documentation/memory/agent-features.webp "Memory and Stable context live under Context in Agent features. Memory lets agents look things up; Stable context tells them what happened recently before they start.")

Memory and [Stable context](/documentation/ambient-awareness) work together. Stable context hands each new session a short list of recent sessions before it starts. Memory lets the agent go and find anything else, however old.

## Ask for it in plain words

Agents reach for it on their own when they start a task someone has touched before, when they debug, and when you mention earlier work. You can also ask directly:

- "Why does the retry logic in the sync client back off the way it does?"
- "Has anyone on the team fixed this error before?"
- "Do it the way we did the auth migration."
- "What did my session on the laptop yesterday decide about the schema?"
- "Before you start, check what's already been tried on the flaky deploy test."

## What you see

- **Answers that cite their source.** The agent names the session a decision came from, and that name is a link. Click it to open the conversation and check the reasoning yourself.
- **Its lookups, folded away.** Each search or read shows as a small *ran …* row above the reply. Expand it to see what the agent looked for and what came back.
- **Less repeated work.** An agent that finds a teammate's session already fixed the bug starts from that fix instead of debugging from scratch.

You can run the same search yourself: press **⌘K** anywhere in the app and type, then **⌘↵** for the full search page. [Search your history across every machine](/documentation/search-sessions-across-machines) covers the search page and its filters.

## What it can see

- **Only what you can see.** An agent searches with your access. Your private sessions are visible to your own agents, and a teammate's session shows up only if it is shared with the team. Which folders are shared is set per folder; see [Team sessions](/documentation/team-sessions).
- **Every machine and every agent.** Sessions from all your connected computers are in one history, so an agent on your desktop can read what your laptop did. Claude Code, Codex, Cursor and Gemini sessions are all searchable, whichever agent is asking.
- **It reads, it doesn't change.** Looking something up never edits, messages or reopens the session it reads.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The agent rediscovers something you know was settled | Check that **Memory** is on for the computer the session runs on, then ask it to look the decision up |
| A teammate's session never comes up | It may not be shared with the team. Ask them, or see [Team sessions](/documentation/team-sessions) |
| Work from another computer is missing | That computer needs codecast running and signed in to the same account |
| An answer quotes an old decision that was later reversed | Ask the agent to check for anything newer; it can read the later session too |
