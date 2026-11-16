A trigger is work an agent does later, on its own: check CI half an hour after a push, summarize the open pull requests every morning, answer review comments when they land. Agents set triggers themselves when they have a reason to, so the follow-through that used to depend on you remembering it just happens. You can also set one yourself from the Triggers page.

![A recurring trigger's page with its next run, history and briefing](/documentation/triggers/trigger.webp "A trigger that runs every day. The page shows when it fires next, every run so far, the briefing each run starts from, and the conversation that set it.")

## Turn it on

Open **Agent features** from your account menu, pick the computer your agents run on, and switch on **Triggers**. Runs happen on that computer, so it needs to be on and connected when a trigger fires.

![The Triggers detail in Agent features](/documentation/triggers/feature.webp "Click How it works on the card to see what it adds and a request to try.")

## Three kinds of trigger

```figure
FiringModesFigure
Twelve hours of three triggers: one that fires once after a delay, one on a schedule, and one that fires on every review comment.
```

- **Once, later.** "In 30 minutes", "tomorrow at 9". Good for following through on something just shipped.
- **On a schedule.** "Every 4 hours", "every day". Good for standing duties: a digest, a sweep, a monitor.
- **On an event.** A pull request opened, reviewed, approved, merged or failing its checks, a review comment, a push, an issue opened or assigned, and errors or failed jobs from the product's own monitoring. Events need GitHub or Linear connected under **Settings**, **Integrations**.

## Ask for it in plain words

- "After you push, check CI in 30 minutes and fix anything red."
- "Every morning at 9, summarize what merged yesterday and what's still open."
- "When someone comments on this pull request, answer the comment and fix what it asks."
- "Check back on the migration tomorrow and tell me if the backfill finished."
- "Pause the nightly sweep."

Agents set a trigger only when there is a concrete follow-up or an event worth reacting to, not as a reflex.

## Set one yourself

On the **Triggers** page, click **New trigger**. Write what the agent should do under **Prompt**, then choose **When**: now, in a while, every so often, or on an event. Pick the agent and, if you like, the project folder it should work in. Tick **read-only: report, don't change anything** when the run should only look and tell you. Click **Set trigger**.

## What you see

### Where a run's result lands

A follow-up on a conversation's own work runs **in that conversation**: it arrives as the next turn, with the whole thread behind it, and the answer appears where the question was asked.

A standing duty runs **in a fresh session each time**, nested under the conversation that set it, so a daily job doesn't keep growing one thread. Each fresh run gets its briefing plus the previous run's summary. A clean run doesn't knock on your inbox; you read it under its trigger. You hear about it when a run fails, stops without reporting, or finishes with something you need to read or decide.

![A trigger run's conversation, ending in its summary](/documentation/triggers/run.webp "One run of the daily trigger, opened from its run history. The bar at the top names the trigger and links back to the conversation that set it; the summary at the bottom is what shows in the run history.")

### The Triggers page

**Triggers** in the sidebar (or the command palette) lists every trigger with its schedule, when it fires next and how its last run went. A strip across the top plots the last and next 24 hours of firings. Filter by recurring, one-time or event, and group by session or project. A trigger that has a cheap way to tell nothing changed can skip a run; that shows as **skipped** in its history and costs nothing.

### One trigger's page

Click a trigger to open its page. **Run now**, **Pause**, **Cancel** and **Edit** sit at the top. Below them: when it fires next, its cadence, how many runs so far, how the last one went, and which computer and folder it runs in. **Run history** lists each run; click one to open its conversation. **Briefing** is exactly what each run is told. Editing a trigger keeps its history, so you can still see what an older run was asked.

Anyone who can see the conversation that owns a trigger can see the trigger's page.

### In the inbox and on your phone

The sidebar shows a small triggers strip with the next firing and anything that needs attention. A conversation tied to a trigger shows it in a bar at its top, with the time to the next firing. Runs that need you reach your phone like any other conversation that needs input.

## What it will and won't do

- **Triggers follow their conversation.** Killing a conversation cancels its triggers; restoring it arms them again.
- **A usage limit pauses a run, it doesn't fail it.** The run picks up where it stopped when the limit resets.
- **Read-only runs stay read-only.** A trigger set to report only can look, but can't edit files or change anything.
- **Only the owner deletes.** Teammates who can see a trigger can't remove it.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| A trigger didn't fire on time | Check that the computer it runs on is awake and connected, then click **Run now** |
| An event trigger never fires | Connect GitHub or Linear under **Settings**, **Integrations**, and check the trigger names the right repository |
| A recurring trigger keeps showing **skipped** | Nothing changed since its last run, so it saved the run. Click **Run now** to force one |
| Runs are filling a conversation | Ask the agent to move the duty to a fresh session per run |

For a fixed sequence of steps with approval gates, see [Workflows](/documentation/workflows). To run a whole plan across many agents, see [Orchestration](/documentation/orchestration).
