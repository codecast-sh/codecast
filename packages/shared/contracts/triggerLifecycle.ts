export function triggerLifecycleInstructions(task: { _id: string; short_id?: string }): string {
  const handle = task.short_id || task._id;
  return [
    "Trigger lifecycle defaults (subordinate to this trigger's prompt, explicit user instructions, and the session's existing permissions):",
    `Save this run's verified outcome with cast trigger complete ${handle} --summary "outcome and evidence". Completing one recurring run alone does not retire its trigger.`,
    "A finding does not survive this run on its own: the session ends with this turn, and the next firing overwrites this trigger's summary. Anything a person or another session must still act on has to leave the run before it completes. File it as a task, add it to the task or plan it already belongs to, or queue a decision when the choice is the human's. Name what you filed in the summary.",
    "--needs-attention claims the human's eyes, so pass it only when they themselves must act, and then open the summary with the ask: what you need them to do, and by when if that matters. Work you have already given an owner does not need their eyes. A summary that leads with what passed, or that says something needs a look without naming the action, spends their attention instead of directing it.",
    `If this is a bounded trigger and its terminal condition is verified complete, save the outcome first, then cancel only this trigger with cast trigger cancel ${handle}.`,
    `A trigger an agent armed stays that agent's to keep proportionate. When the firings stop earning what they cost, widen the interval with cast trigger update ${handle} --every <longer>, and cancel it once the work it watches is done or gone. A quiet run is a reason to slow a trigger down, never a reason to call it complete.`,
    "Quiet or no-change results, quota errors, collector failures, unavailable sources, and pending deadlines are NOT proof of completion. Preserve future checks until their conditions are verified.",
    "Ongoing mandates remain active until explicitly ended. Do not close unrelated tasks or cancel other triggers.",
    "Preserve safe-mode restrictions: if cancellation is outside this run's authority, report the verified outcome and required cancellation in the completion summary instead of executing it.",
  ].join("\n");
}

// The session that OWNS a fresh run. A ONCE trigger armed from inside a
// session and run in a fresh one is that session's worker: it answers a
// question the session asked, so the run nests under it (the same subagent
// row `cast spawn --subagent` makes) and its outcome comes back to it. A
// repeating trigger belongs to nobody in particular: its standing row carries
// the latest summary, and nesting every firing under the session that once
// installed it would file a role's routine under a long-dead installer. An
// inject trigger has no fresh run to own.
export function runOwnerOf<Id extends string>(task: {
  schedule_type?: string;
  originating_conversation_id?: Id;
  created_by_conversation_id?: Id;
}): Id | undefined {
  const onceSpawn = task.schedule_type === "once" && !task.originating_conversation_id;
  return onceSpawn ? task.created_by_conversation_id : undefined;
}

// How a fresh run ended, as the owner sees it. "reported": the agent ran
// `cast trigger complete` and nobody needs to act. "attention": it completed
// with --needs-attention. "unreported_exit": the process ended without
// reporting (the agent forgot, crashed, or never started). "failed": the
// scheduler gave up after the retry budget.
export type RunOutcome = "reported" | "attention" | "unreported_exit" | "failed";

// Which conversation a finished run WAKES, as a conversation id: the owner
// takes a turn on the outcome, so a run that failed, died or asked for a
// person is never a card nobody acts on. A clean report is read at leisure
// and wakes the owner only when the trigger asked for it (`--wake`), because
// waking a session whose prompt cache has expired rebuilds its whole context,
// which is the cost `--spawn` was chosen to avoid.
export function runOwnerWakeOf<Id extends string>(
  task: {
    schedule_type?: string;
    originating_conversation_id?: Id;
    created_by_conversation_id?: Id;
    wake_creator?: boolean;
  },
  outcome: RunOutcome,
): Id | undefined {
  const owner = runOwnerOf(task);
  if (!owner) return undefined;
  if (outcome === "reported") return task.wake_creator ? owner : undefined;
  return owner;
}

// Where a finished run's result is read, as a conversation id. `--thread` names
// the conversation outright; otherwise the run's owner (runOwnerOf), which is
// where the human is reading. A repeating trigger never posts to its creator
// on its own, because one line per firing would bury the thread.
//
// One definition for both readers: the server posts by it
// (agentTasks.settleRunConversation) and the daemon briefs the run by it
// (taskScheduler.buildPrompt), so the agent is told its summary lands in a
// thread exactly when it does.
export function runResultThreadOf<Id extends string>(task: {
  schedule_type?: string;
  target_conversation_id?: Id;
  originating_conversation_id?: Id;
  created_by_conversation_id?: Id;
}): Id | undefined {
  return task.target_conversation_id ?? runOwnerOf(task);
}
