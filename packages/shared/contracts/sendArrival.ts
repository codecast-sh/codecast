// When a `cast send` reaches its target, decided at send time from facts the
// server already holds. Idea from flopwire's send receipt `arrives`
// (docs/messaging.md step 3).
//   now            live and settled: the daemon types it in right away
//   next_tool_call live and mid-turn, and it reads input between tool calls:
//                  Claude Code takes type-ahead with its next tool result (a
//                  turn that makes no further call takes it when it ends)
//   end_of_turn    live and mid-turn (or compacting)
//   after_prompt   live, with a permission prompt or question open: delivered
//                  once someone answers it
//   after_start    its process is still starting or resuming
//   on_resume      no running agent, its machine is up: the daemon resumes it to deliver
//   when_online    its machine is offline: delivered when the daemon comes back
//   held           the session's safety stop holds all input until a person clears it
//   with_owner     a teammate's words while an owner is in the session: they wait
//                  as a suggestion that owner sends, edits or dismisses (teamSuggestions.ts)
//   never          a workflow run's log: it has no agent, so the message stays on its record
export type SendArrival = "now" | "next_tool_call" | "end_of_turn" | "after_prompt" | "after_start" | "on_resume" | "when_online" | "held" | "with_owner" | "never";

// One live process behind the target: its status after trust decay
// (trustedAgentStatus), whether it would take a message now, and whether it
// reads input mid-turn.
export type SendArrivalSession = { status?: string; ready: boolean; typeAhead: boolean };

export function sendArrival(t: {
  safetyBlocked: boolean;
  runLog: boolean;
  hosted: boolean;
  sessions: SendArrivalSession[];
  queued: boolean;
  ownerOnline: boolean;
}): SendArrival {
  if (t.runLog) return "never";
  if (t.safetyBlocked) return "held";
  // A hosted conversation's turn engine is woken by the enqueue itself.
  if (t.hosted) return "now";
  if (t.sessions.some((s) => s.ready)) return "now";
  // Several live rows can disagree (an old row still heartbeating beside the
  // current process): the soonest any of them takes the message wins.
  const running = t.sessions.filter((s) => s.status !== "stopped" && s.status !== "hibernated");
  if (running.length === 0) return t.ownerOnline ? "on_resume" : "when_online";
  const busy = running.filter((s) => !SLOWER_THAN_A_TURN.includes(s.status ?? ""));
  // "Queue for later" is held for the end of the turn on purpose.
  if (busy.length > 0) return !t.queued && busy.some((s) => s.typeAhead && s.status !== "compacting") ? "next_tool_call" : "end_of_turn";
  return running.some((s) => s.status !== "permission_blocked") ? "after_start" : "after_prompt";
}

// Live statuses that take a message later than the end of a turn would.
const SLOWER_THAN_A_TURN = ["permission_blocked", "starting", "resuming", "connected"];

// The receipt's words for each arrival, completing "arrives …".
export function sendArrivalPhrase(arrives: SendArrival): string {
  switch (arrives) {
    case "now": return "now";
    case "next_tool_call": return "at its next tool call";
    case "end_of_turn": return "when its current turn ends";
    case "after_prompt": return "once someone answers the prompt open in it";
    case "after_start": return "once it finishes starting";
    case "on_resume": return "once its machine resumes it";
    case "when_online": return "when its machine comes back online";
    case "held": return "only after a person clears its safety stop";
    case "with_owner": return "if its owner sends your suggestion";
    case "never": return "never: a run's log has no agent, so it stays on the run's record";
  }
}
