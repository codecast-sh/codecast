export function triggerLifecycleInstructions(task: { _id: string; short_id?: string }): string {
  const handle = task.short_id || task._id;
  return [
    "Trigger lifecycle defaults (subordinate to this trigger's prompt, explicit user instructions, and the session's existing permissions):",
    `Save this run's verified outcome with cast trigger complete ${handle} --summary "outcome and evidence". Completing one recurring run alone does not retire its trigger.`,
    "A finding does not survive this run on its own: the session ends with this turn, and the next firing overwrites this trigger's summary. Anything a person or another session must still act on has to leave the run before it completes. File it as a task, add it to the task or plan it already belongs to, or queue a decision when the choice is the human's. Name what you filed in the summary.",
    "--needs-attention claims the human's eyes, so pass it only when they themselves must act, and then open the summary with the ask: what you need them to do, and by when if that matters. Work you have already given an owner does not need their eyes. A summary that leads with what passed, or that says something needs a look without naming the action, spends their attention instead of directing it.",
    `If this is a bounded trigger and its terminal condition is verified complete, save the outcome first, then cancel only this trigger with cast trigger cancel ${handle}.`,
    "Quiet or no-change results, quota errors, collector failures, unavailable sources, and pending deadlines are NOT proof of completion. Preserve future checks until their conditions are verified.",
    "Ongoing mandates remain active until explicitly ended. Do not close unrelated tasks or cancel other triggers.",
    "Preserve safe-mode restrictions: if cancellation is outside this run's authority, report the verified outcome and required cancellation in the completion summary instead of executing it.",
  ].join("\n");
}

// Where a finished run's result is read, as a conversation id. `--thread` names
// the conversation outright. A ONCE trigger armed from inside a session and run
// in a fresh one answers a question that session asked, so its result goes back
// there: the fresh run is the worker, the creating thread is where the human is
// reading. A repeating trigger never posts to its creator on its own, because
// one line per firing would bury the thread; its standing row carries the
// latest summary. An inject trigger has no fresh run to route.
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
  if (task.target_conversation_id) return task.target_conversation_id;
  const onceSpawn = task.schedule_type === "once" && !task.originating_conversation_id;
  return onceSpawn ? task.created_by_conversation_id : undefined;
}
