A workflow is a process you want run the same way every time: build the change, run the checks, loop back if they fail, then stop and wait for you to approve before anything ships. Each step is an agent, a command, or a point where a person decides. Where a single prompt describes what you want and hopes the agent follows it, a workflow fixes the order, the checks and the sign off.

Workflows only run when you start one. Agents never start one on their own.

![A workflow run paused at its approval gate](/documentation/workflows/gate.webp "A run waiting at its Approve step. The choices are the gate's way out; you can also answer in your own words.")

## Turn it on

Open **Agent features** from your account menu, pick the computer your agents run on, and switch on **Workflows**.

![The Workflows detail in Agent features](/documentation/workflows/feature.webp "Click How it works on the card to see what it adds and a request to try.")

## Make one by asking

You describe the process; the agent writes the workflow and checks that it is valid. It lives in your project as a small file, so it can be reviewed and changed like code.

- "Write a workflow that implements a task, typechecks, and waits for my approval before merging."
- "Add a step to the release workflow that runs the end to end tests before the approval."
- "Make the review loop give up after three failed attempts."

A workflow can hold these kinds of steps:

- **An agent step**: a session with its own instructions, on Claude, Codex or another agent.
- **A command**: tests, a typecheck, a build. Whether it passes decides where the run goes next.
- **An approval gate**: the run stops until a person picks one of its choices.
- **A branch**: route on the result of the step before it, or run several steps side by side and wait for them all.

## Run it

Ask the agent: "Run the review workflow on the theme switch task." A run is always tied to a [task or plan](/documentation/tasks-and-plans), which is where it gets its goal and context.

You can also start one from the app. Open **Workflows** from the command palette, pick a workflow, click **Run**, and give it the project folder and, if you like, a goal. A plan that has a workflow attached shows a **Run workflow** button on its page.

```figure
WorkflowRunFigure
One run: the first typecheck fails and loops back to the agent, the second passes, and the run waits at the gate until someone approves.
```

## What you see

### The run page

Each run has a page. The top line says where the run stands, such as *Waiting for an answer at Approve*, with the task it belongs to. **The path** lists each step that ran and what it produced. **Show the graph** draws the whole workflow with the current step highlighted, and below it every step with how long it took. Each agent step is a real conversation you can open and read.

![The workflow's graph and its steps](/documentation/workflows/graph.webp "The graph under Show the graph: the check passed, the run sits at Approve, and Revise would send it back to the check.")

### Answering a gate

When a run reaches a gate, it waits. The question appears on the run page, in your decision queue, and as a notification on your phone and desktop. Pick a choice, or write a reply in your own words: your words travel to the next step as its instructions, so "Revise: keep the old setting as the default" sends the work back with that note. **Dismiss** ends the run there.

While a run is waiting, its task shows as in review on the task and plan pages.

## Workflows, orchestration or triggers

Use a **workflow** when you know the steps and they must run the same way every time: a release checklist, a verify loop, anything with a required sign off. Use [orchestration](/documentation/orchestration) when the shape of the work isn't known up front and a lead agent should work it out and spread it across many agents. Use a [trigger](/documentation/triggers) for a single follow-up later or on an event, with no graph at all.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| A run failed right after a gate | It was dismissed, or the gate had no matching way out for the answer. Start it again and pick one of the listed choices |
| A run keeps looping | Ask the agent to give the loop a limit, so it stops after a few failed attempts |
| **Workflows** isn't in the command palette | It appears with the developer views of the app. Asking an agent to run a workflow works either way |
