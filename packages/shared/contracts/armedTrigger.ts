// Whether a trigger is a wake that will bring its session back: it injects
// into a session, it will fire (scheduled or running; a paused one fires only
// once a person resumes it), and its last run neither failed nor flagged
// attention (that run asks for a look, so it is no wake to lean on). One
// predicate for the server's dormancy and close facts (convex dormancy.ts,
// closeAdvice) and the web's Close tooltip (lib/closeFactsInStore), so they
// count the same triggers. A kill's notice counts a different set, what a
// kill cancels (web triggerTasks armedInjectTasksFor), paused ones included.
export const ARMED_TRIGGER_STATUSES = ["scheduled", "running"] as const;

export type InjectTriggerTask = {
  originating_conversation_id?: unknown;
  status: string;
  last_run_failed?: boolean | null;
  last_run_needs_attention?: boolean | null;
};

export function isArmedInjectTrigger(task: InjectTriggerTask): boolean {
  if (!task.originating_conversation_id) return false;
  if (!(ARMED_TRIGGER_STATUSES as readonly string[]).includes(task.status)) return false;
  if (task.last_run_failed || task.last_run_needs_attention) return false;
  return true;
}
