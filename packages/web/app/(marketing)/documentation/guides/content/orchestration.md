Orchestration hands a whole [plan](/documentation/tasks-and-plans) to one agent and lets it run a team. That lead agent splits the goal into tasks, starts an implementer agent for every task that is ready, has a reviewer check each one before it lands, and finishes with critics who look over the combined result. Several tasks move at once, and you watch the plan fill in rather than steering one conversation through every step.

It only starts when you ask for it.

![A plan's Orchestration tab while agents work on it](/documentation/orchestration/plan.webp "The Orchestration tab on a plan: how many agents are working, how many tasks are done, any that are stuck, and each task's status in order.")

## Turn it on

Open **Agent features** from your account menu, pick the computer your agents run on, and switch on **Orchestration**. It works with Claude Code, and the computer it runs on does the work, so a plan of many tasks keeps that machine busy for a while.

![The Orchestration detail in Agent features](/documentation/orchestration/feature.webp "Click How it works on the card to see what it adds and a request to try.")

## Ask for it in plain words

- "Make a plan for the settings redesign, then orchestrate it."
- "Orchestrate the dark mode plan."
- "Orchestrate the rest of the billing plan, two tasks at a time."
- "Stop after the first wave so I can look at it."

If there is no plan yet, ask for one first and read it over. The plan is where you shape the work: its goal, its tasks and what depends on what.

## How the work moves

```figure
WavesFigure
Eight tasks in three waves. Each wave starts the moment the work it depends on is done.
```

**In waves.** Every task whose dependencies are done starts at once, each with its own implementer. As those finish, the next tasks unlock.

**Each in its own copy.** Every implementer works in a separate copy of your repository on its own branch, so agents running side by side never trip over each other's files. Finished work merges back once it passes review.

```figure
ReviewVerdictFigure
A reviewer's verdict decides each task's path. After a few failed rounds, the lead agent asks you instead of looping.
```

**Reviewed before it lands.** A reviewer checks each finished task against what the task asked for and passes it, sends it back with notes, or rejects it. The lead agent tries a task a few times at most, then stops and asks you.

```figure
CriticRoundFigure
Critics look at the whole result, not single tasks. Serious findings go back in as a new wave.
```

**A final sweep.** Once every task has passed, critics review the combined code. Anything serious becomes new fix tasks and another wave; when they find nothing serious, the plan is done.

## What you see

- **The plan page.** Tasks move from open to in progress to done as agents pick them up and finish. The **Orchestration** tab shows how many agents are working, how many tasks are complete, and any that are blocked, with each task's status in order. **Graph** draws what depends on what.
- **The lead agent's conversation.** It narrates each wave: what it started, what passed review, what it sent back. You can message it at any point to change course.
- **The plan's timeline.** Progress at the end of each wave and the decisions the lead agent made land on the plan, so the record of why survives the run.
- **Your inbox, when it needs you.** A task the agents can't finish, a rejected review or a missing piece of context comes back to you as a question, and the conversation is flagged as needing input.

## Orchestration or a workflow

Choose orchestration when the shape of the work isn't known up front and an agent should work it out. When the steps are known and must run the same way every time, with an approval at a fixed point, use a [workflow](/documentation/workflows) instead.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| The lead agent asks you about a task | Answer in its conversation. It carries on with the rest of the plan meanwhile |
| Too many agents run at once for your machine | Tell the lead agent to run fewer tasks at a time |
| A task is stuck in progress | Open the task; its sessions and activity show where it stopped. Ask the lead agent to retry or split it |
| The plan's tasks look wrong before it starts | Edit the plan first, or ask for a new breakdown. Orchestrating a bad plan just builds the wrong thing faster |
