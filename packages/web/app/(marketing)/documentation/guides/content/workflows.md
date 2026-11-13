A workflow is a process you want run the same way every time: build the change, run the checks, loop back if they fail, then stop and wait for you to approve before anything ships. Each step is an agent, a command, or a point where a person decides. A prompt describes what you want and hopes the agent follows it; a workflow fixes the order, the checks and the sign-off.

Workflows only run when someone starts one. Agents never start one on their own.

![A workflow run paused at its approval gate](/documentation/workflows/gate.webp "A run waiting at its Approve step. Pick a choice or answer in your own words.")

## Turn it on

Open **Agent features** (under **More** in the sidebar), pick the computer your agents run on, and switch on **Workflows** under **Tracking & automation**.

![The Workflows card in Agent features](/documentation/workflows/feature.webp "Click How it works on the card for what it adds and a request to try.")

## Make one by asking

Describe the process and the agent writes the workflow and checks that it is valid. It lives in your project as a small file, so it can be reviewed and changed like code.

- "Write a workflow that implements a task, typechecks, and waits for my approval before merging."
- "Add a step to the release workflow that runs the end to end tests before the approval."
- "Make the review loop give up after three failed attempts."

A workflow can hold these kinds of steps:

- **An agent step**: a session with its own instructions, on Claude, Codex or another agent.
- **A command**: tests, a typecheck, a build. Whether it passes decides where the run goes next.
- **An approval gate**: the run stops until a person picks one of its choices.
- **A branch**: route on the result of the step before, or run several steps side by side and wait for them all.

## Start a run

Click **Workflows** in the sidebar, under **Automation**. **Routines** lists your workflows and **Runs** lists the runs so far. Pick a workflow and click **Run**, give it the **Project path** and, if you like, a **Goal override**, then click **Run**. A review shows the steps and agents it will start; confirm it there.

![Starting a workflow run](/documentation/workflows/start.webp "The run dialog: the project, an optional goal, and Run.")

A plan with a workflow attached has a **Run workflow** button on its page. You can also ask in a conversation: "Run the review workflow on the webhook retries task." A run is tied to a [task or plan](/documentation/tasks-and-plans), which is where it gets its goal and context.

```figure
WorkflowRunFigure
One run: the first typecheck fails and loops back to the agent, the second passes, and the run waits at the gate until someone approves.
```

## The run page

Each run has a page. The top line says where the run stands, and links under it open the session that ran it, its task and the decision it is waiting on. Below, every step is listed by phase with how far each phase got and how long each step took. Each agent step is a real conversation you can open and read. **Show the graph** draws the whole workflow with the current step highlighted.

![The workflow's graph and its steps](/documentation/workflows/graph.webp "The graph: the check passed, the run sits at Approve, and Revise would send it back.")

## Answer a gate

When a run reaches a gate, it waits. The question appears on the run page, in **Decisions**, and as a notification on your phone and desktop. Pick a choice, or write a reply in your own words: your words travel to the next step as its instructions, so "Revise: keep the old retry limit as the default" sends the work back with that note. **Dismiss** ends the run there.

While a run is waiting, its task shows **In Review** on the task and plan pages.

## Workflows, orchestration or triggers

Use a **workflow** when you know the steps and they must run the same way every time: a release checklist, a verify loop, anything with a required sign-off. Use [orchestration](/documentation/orchestration) when the shape of the work isn't known up front and a lead agent should work it out across many agents. Use a [trigger](/documentation/triggers) for a single follow-up later or on an event, with no graph at all.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| A run failed right after a gate | It was dismissed, or the answer matched none of the gate's ways out. Start it again and pick one of the listed choices |
| A run keeps looping | Ask the agent to give the loop a limit, so it stops after a few failed attempts |
| Nothing listed under **Routines** | No workflow has been written in this workspace yet. Ask an agent to write one |
