Every coding agent your team runs already keeps a full record of its session on the machine that ran it: Claude Code, Codex, Cursor, OpenCode, pi, Grok and Gemini all do. Nobody else can see those records. Codecast puts the sessions in one place for the whole team, live, without anyone changing how they run their agents.

Each teammate installs Codecast once ([Getting started](/documentation#getting-started)). From then on, every session they start in a terminal, an editor, tmux or over SSH shows up in Codecast as it happens. You choose which of your folders the team can see, and everything else stays yours.

## Two ways to look at the same sessions

**Activity**, under **Team** in the sidebar, is every session the team can see, newest activity first, across machines and agents. **Now** at the top lists who is working at this moment. **Team** and **Mine** switch between everyone's work and yours. Click teammates' faces to see only their sessions, pick a project from the project menu, or press **Needs someone** to see only the sessions waiting on a person. **People** and **Projects** at the right group the list by who or by repository. Each filter is part of the page's address, so a filtered view can be sent to someone.

![The Activity page: Alex Rivera, Maya Ortiz and Sarah Chen's sessions on the webhook retries work, newest first, with their faces above as filters](/documentation/team-sessions/activity.webp "Activity shows what the team's sessions did, filtered here to one project.")

**Inbox** files your sessions by who has to act next:

| Section | What is in it |
|---------|---------------|
| **Decisions** | Questions agents are waiting on you for ([Decisions](/documentation/decisions)) |
| **Needs You** | Blocked on you: a question, a permission prompt, a finished turn to review |
| **Done** | Delivered. Read it when you have time |
| **Working** | The agent is still going |
| **Dormant** | Waiting on something scheduled, such as a test run or a reply |

![The inbox with sessions under Needs You, Done and Working, and one conversation open beside it](/documentation/shots/inbox.webp "The inbox files sessions by who acts next, from every machine and every agent.")

Open any session to read the whole conversation as it unfolds: messages, commands, file changes as diffs. Looking at a teammate's stuck session and helping with it happen in the same place, on the web, in the Mac app or on your phone.

![The phone inbox with the team's sessions filed under Needs You and Working](/documentation/team-sessions/phone-inbox.webp "The same inbox on the phone.")

## Choose what the team sees

Sharing is set per folder, so you decide once. Your work repository can be visible to the team while your personal experiments stay private, on the same account.

When you join a team, the **What teammates see** step asks which repositories you work in with that team. You can change it any time in **Settings → Sync & Privacy**, under **Sharing**:

- Every repository and folder Codecast has seen is listed under the team it is shared with, with how many sessions it holds. The rest sit under **Private — only you** or **Never shared — locked by you**.
- Click a repository's share control and pick **Only me**, a team, or **Never share**.
- When you pick a team, the panel shows exactly who will see what: how many teammates, how many sessions, and over which dates. Choose whether the share covers **Everything, past sessions included**, starts **From today on**, or starts **Since a date**, and untick any session you want to keep private. Nothing changes until you press **Share with** and the team's name.
- **Never share** locks a folder, so nothing in it reaches a team even if a folder around it is shared.

![Sync & Privacy, Sharing: the webhooks repository shared with Acme, a scratch folder under Private — only you, and the share control open](/documentation/team-sessions/sharing-settings.webp "Each repository and who it is shared with.")

![The share review for a repository: 2 teammates, 14 sessions, and From today on selected](/documentation/team-sessions/share-review.webp "The review before a share takes effect.")

```figure
VisibilityRuleFigure
Five sessions on one account. The closest folder setting wins, a clone follows its repository, and anything nothing covers stays private.
```

Copies of a repository follow its setting, including the worktrees some agents create outside your project folder. For a single session, the share button in the conversation header sets what the team sees of it: **Hidden**, **Summary** or **Full**. See [Share a session](/documentation/share-a-session).

## What sharing makes possible

Because every session lands in one place, the record keeps paying off after the work is done:

- Search every past session on the team from the search box at the top of the app.
- Ask any agent how the flaky deploy got fixed last month. It searches the team's sessions and answers with links to them ([Memory](/documentation/memory)).
- Trace a line of code back to the conversation that wrote it ([Which session wrote this line](/documentation/which-session-wrote-this-line)).

## When something is off

| What you notice | What to do |
|-----------------|------------|
| Your sessions are missing from Activity | Activity shows *Your sessions are hidden from* your team. Click **Share workspaces** and share the repositories you work in |
| A teammate's sessions are missing | They haven't shared that repository yet, or their computer hasn't connected. Shared sessions appear as soon as their Codecast is running |
| Old sessions showed up after you shared | You picked *Everything, past sessions included*. Open the repository in **Sync & Privacy** and change it to **From today on**, or untick the sessions to keep private |
| A folder should never reach the team | Set it to **Never share** in **Sync & Privacy** |
