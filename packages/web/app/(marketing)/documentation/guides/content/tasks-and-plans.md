When an agent takes on work that will run for a while, it files it where you can see it. A **task** is one piece of work: a feature, a bug, a chore. A **plan** groups several tasks under one goal. Agents create them, claim them, post progress as they go, and close each one with a line on what they checked. You follow it on the task and plan pages instead of scrolling back through conversations.

![A plan with its goal, progress bar and four tasks](/documentation/tasks-and-plans/plan.webp "A plan an agent filed: one task done, one in progress with its session, two still open.")

## Turn it on

Open **Agent features** (under **More** in the sidebar), pick the computer your agents run on, and switch on **Tasks & Plans** under **Tracking & automation**. Do it on each computer you use.

![The Tasks & Plans card in Agent features](/documentation/tasks-and-plans/feature.webp "Click How it works on the card for what it adds and a request to try.")

## What agents file, and what they don't

Agents use judgment here, not a rule that every request becomes a task:

- **A task** when the work will outlive the conversation, needs a handoff, or should be tracked so you can check on it.
- **A plan** when the work has several distinct parts that could run in separate sessions.
- **Nothing** for questions, quick lookups and small fixes they will finish right away.

Before filing anything, an agent looks for an existing task or plan on the same topic and picks that up instead of making a duplicate.

## Ask for it

- "Break the billing rewrite into a plan with tasks we can split across sessions."
- "File a task for the flaky webhook retry test and start on it."
- "Pick up the next ready task in the webhook retries plan."
- "What's left on the onboarding plan?"
- "Mark the export task done, with what you verified."

## The Tasks page

Click **Tasks** in the sidebar, under **Work**. It lists every task in your workspace. Switch between **List** and **Board** at the top, filter by status, priority, label or assignee, and click **Add task** to file one yourself. Work filed in a team shows to that team; work you file privately stays yours.

![The Tasks page as a board](/documentation/tasks-and-plans/board.webp "The Board view: tasks in columns by status, each with its assignee.")

## A task's page

Click a task to open it. Its status moves through **Backlog**, **Open**, **In Progress**, **In Review** and **Done**, with **Dropped** for work that won't happen. Change the status, priority and assignee yourself from the row at the top.

![A finished task with its evidence, session, plan and activity](/documentation/tasks-and-plans/task.webp "A task an agent closed, with what it verified and the session that did the work.")

- **Session** shows the session working on the task, and you can read it and answer it right there. With no session yet, click **Hand to an agent** to start one.
- **Evidence** is what the agent says it verified when it marked the task done. Agents are told to close only work they actually checked.
- **Sessions** (or **Other sessions**, when one is working on it now) links every conversation that worked on the task.
- **Plan** links the plan the task belongs to.
- **Blocks** and **Blocked by** show what has to finish first. A task waiting on another doesn't show as ready until that one is done.
- **Activity** is the running log: status changes and the agent's progress notes.
- **Leave a comment** at the bottom. When a session is working on the task, the comment also goes to that session (*Also sends to this session*), so you can steer the work from the task page.

## A plan's page

Open **Plans** from the command palette, or click the plan named on any of its tasks. The goal sits under the title, with a progress bar across all its tasks, and four tabs:

- **Overview** lists the tasks and the plan's timeline. Decisions an agent makes along the way land here, so the reasons survive after the conversations end.
- **Orchestration** shows which agents are working which tasks right now ([Orchestration](/documentation/orchestration)).
- **Board** lays the tasks out by status.
- **Graph** draws what depends on what.

## On your phone

The **Tasks** tab in the iPhone app has **Tasks**, **Plans**, **Docs** and **Triggers**. Open a task to see its status, plan, blockers and activity, and add a comment; open a plan to see its tasks.

![The Tasks tab on the iPhone app](/documentation/tasks-and-plans/phone.webp "The Tasks tab on the phone, with open tasks at the top.")

## When an agent needs you

If an agent gets stuck, it says so instead of going quiet: blocked on something only you can provide, missing context, or finished with a concern you should look at. The conversation is flagged in your inbox as needing you, and the reason sits on the task.

## Where this leads

Tasks and plans are what the rest of the tracking tools hang on. [Orchestration](/documentation/orchestration) runs a whole plan across many agents at once. [Workflows](/documentation/workflows) run a fixed sequence of steps against a task, with approval gates. [Triggers](/documentation/triggers) come back to a task later or on a schedule.
