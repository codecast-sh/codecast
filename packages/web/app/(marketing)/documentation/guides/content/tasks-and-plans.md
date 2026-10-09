When an agent takes on work that will run for a while, it files it where you can see it. A **task** is one piece of work: a feature, a bug, a chore. A **plan** groups several tasks under one goal. Agents create them, claim them, post progress as they go, and close each one with a line on what they checked. You follow all of it on the Tasks and Plans pages instead of scrolling back through conversations.

![A plan with its goal, progress bar and four tasks](/documentation/tasks-and-plans/plan.webp "A plan an agent filed: the goal in its charter, one task done, one in progress with the session working on it, and two still open.")

## Turn it on

Open **Agent features** from your account menu, pick the computer your agents run on, and switch on **Tasks & Plans**. Repeat it on each computer you use.

![The Tasks & Plans detail in Agent features](/documentation/tasks-and-plans/feature.webp "Click How it works on the card to see what it adds and a request to try.")

## What agents file, and what they don't

Agents use judgment here, not a rule that every request becomes a task:

- **A task** when the work will outlive the conversation, needs a handoff to someone else, or should be tracked so you can check on it.
- **A plan** when the work has several distinct parts that could run in separate sessions.
- **Nothing** for questions, quick lookups and small fixes they will finish right away.

Before filing anything, an agent looks for an existing task or plan on the same topic and picks that up instead of making a duplicate.

## Ask for it in plain words

- "Break the billing rewrite into a plan with tasks we can split across sessions."
- "File a task for the flaky checkout test and start on it."
- "Pick up the next ready task in the dark mode plan."
- "What's left on the onboarding plan?"
- "Mark the export task done, with what you verified."

## What you see

### The task page

Every task has its own page. At the top is its status, which moves through **Backlog**, **Open**, **In Progress**, **In Review** and **Done**, with **Dropped** for work that won't happen. You can change the status, priority and assignee yourself from the same row.

![A finished task with its evidence, session, plan and activity](/documentation/tasks-and-plans/task.webp "A task an agent closed. Evidence holds what it verified, Sessions links the conversation that did the work, and Activity lists each status change and progress note.")

- **Evidence** is what the agent says it verified when it marked the task done. An agent is told to close only work it actually checked.
- **Sessions** links every conversation that worked on the task, so you can open the one that did the work.
- **Blocks** and **Blocked by** show what has to finish first. A task waiting on another doesn't show as ready until that one is done.
- **Activity** is the running log: status changes and the agent's progress notes, newest at the bottom.
- **Add comment** leaves a note on the task. If a session is working on it, the comment also reaches that session, so you can steer the work from the task page.

### The plan page

A plan page shows the goal at the top under **Charter** (with optional success metrics and non goals), a progress bar across all its tasks, and four tabs: **Overview** lists the tasks and the plan's timeline, **Orchestration** shows which agents are working which tasks right now, **Board** lays the tasks out by status, and **Graph** draws what depends on what. Decisions an agent makes along the way land on the plan's timeline, so the reasons survive after the conversations end.

### The Tasks and Plans pages

**Tasks** and **Plans** in the sidebar (or the command palette) list everything in your workspace. Work you file in a team shows to that team; work you file privately stays yours.

### On your phone

The iPhone app shows the same tasks and plans, so you can check progress and leave a comment away from your desk.

## When an agent needs you

If an agent gets stuck, it says so plainly instead of going quiet: blocked on something only you can provide, missing context, or finished but with a concern you should look at. The conversation is flagged as needing your attention in the inbox, and the reason sits on the task.

## Where this leads

Tasks and plans are what the rest of the tracking tools hang on. [Orchestration](/documentation/orchestration) runs a whole plan across many agents at once. [Workflows](/documentation/workflows) run a fixed sequence of steps against a task, with approval gates. [Triggers](/documentation/triggers) come back to a task later on a schedule.
