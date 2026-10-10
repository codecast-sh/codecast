Every coding agent your team runs already keeps a full record of its session on the machine that ran it. Claude Code does, and so do Codex, Cursor, OpenCode, pi, Grok and Gemini. The work is recorded; nobody else can see it. Codecast puts those sessions in one place for the whole team, live, without anyone changing how they run their agents.

Each teammate installs codecast once ([Getting started](/documentation#getting-started)). From then on, every session they start in a terminal, an editor, tmux or over SSH shows up in codecast as it happens. You choose which of your folders the team can see, and everything else stays yours.

![The codecast inbox with a team's sessions](/documentation/shots/inbox.webp "The inbox files sessions under Needs input, Done and Working, from every machine and every agent, with one open beside it.")

## Two ways to look at the same sessions

```figure
FeedInboxFigure
The feed answers what is happening across the team. The inbox answers what needs you.
```

**Feed**, in the sidebar, is every session the team can see, newest activity first, across machines and agents. Click a teammate's face to see only their sessions, or a repository to narrow it to one project. **Git & issues** mixes in commits, pull requests and issues from GitHub and Linear.

**Inbox** files your sessions by who has to act next:

| Section | What is in it |
|---------|---------------|
| **Questions** | Decisions agents are waiting on you for ([Decisions](/documentation/decisions)) |
| **Needs Input** | Blocked on you: a question, a permission prompt, a finished turn to review |
| **Done** | Delivered. Read it when you have time |
| **Working** | The agent is still going |
| **Dormant** | Waiting on something scheduled, such as a test run or a reply |

Open any session to read the whole conversation as it unfolds: messages, commands, file changes as diffs. So looking at a teammate's stuck session and helping with it happen in the same place, on the web, in the Mac app or on your iPhone.

## Choose what the team sees

Sharing is set per folder, not per session, so you decide once. Your work repository can be visible to the team while your personal experiments stay private, on the same account.

When you join a team, the **Where you work** step asks which repositories you work in with that team. You can change it any time in **Settings → Sync & Privacy**, under **Sharing**:

- Every repository and folder codecast has seen is listed under the team it is shared with, with how many sessions it holds and when they started. Others sit under **Private — only you** or **Never shared — locked by you**.
- Click a repository's share control and pick **Only me**, a team, or **Never share**. Before you confirm, codecast tells you exactly who will see what: how many teammates, how many sessions, and over which dates.
- Choose whether the share covers **Everything, past sessions included**, starts **From today on**, or starts **Since a date**. You can untick individual sessions to keep them private.
- **Never share** locks a folder, so nothing in it reaches a team even if a broader folder around it is shared.

```figure
VisibilityRuleFigure
Five sessions on one account. The closest folder setting wins, a clone follows its repository, and anything nothing covers stays private.
```

Copies of a repository follow its setting, including the worktrees some agents create outside your project folder. For a single session, the share button in the conversation header sets what the team sees of it: **Hidden**, **Summary** (the title and a summary of the work) or **Full**. See [Share a session](/documentation/share-a-session).

## What sharing makes possible

Because every session lands in one place, the record keeps paying off after the work is done:

- Search every past session on the team from **Search sessions** at the top of the app.
- Ask any agent how the flaky deploy got fixed last month. It searches the team's sessions and answers with links to them ([Agent memory](/documentation/memory)).
- Trace a line of code back to the conversation that wrote it ([Which session wrote this line](/documentation/which-session-wrote-this-line)).

## When something is off

| What you notice | What to do |
|-----------------|------------|
| Your sessions are missing from the team feed | The feed shows *Share your workspaces with the team*. Click **Set up sharing** and share the repositories you work in |
| A teammate's sessions are missing | They haven't shared that repository yet, or their computer hasn't connected. Shared sessions appear as soon as their codecast is running |
| Old sessions showed up after you shared | You picked *Everything, past sessions included*. Open the repository in **Sync & Privacy** and change it to **From today on**, or untick the sessions to keep private |
| A folder should never reach the team | Set it to **Never share** in **Sync & Privacy** |
