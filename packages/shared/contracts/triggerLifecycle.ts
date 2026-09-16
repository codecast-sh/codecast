export function triggerLifecycleInstructions(task: { _id: string; short_id?: string }): string {
  const handle = task.short_id || task._id;
  return [
    "Trigger lifecycle defaults (subordinate to this trigger's prompt, explicit user instructions, and the session's existing permissions):",
    `Save this run's verified outcome with cast trigger complete ${handle} --summary "outcome and evidence". Completing one recurring run alone does not retire its trigger.`,
    `If this is a bounded trigger and its terminal condition is verified complete, save the outcome first, then cancel only this trigger with cast trigger cancel ${handle}.`,
    "Quiet or no-change results, quota errors, collector failures, unavailable sources, and pending deadlines are NOT proof of completion. Preserve future checks until their conditions are verified.",
    "Ongoing mandates remain active until explicitly ended. Do not close unrelated tasks or cancel other triggers.",
    "Preserve safe-mode restrictions: if cancellation is outside this run's authority, report the verified outcome and required cancellation in the completion summary instead of executing it.",
  ].join("\n");
}
