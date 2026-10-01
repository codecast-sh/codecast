// Which triggers the strip above a conversation shows (TriggerContextPanel),
// pure so the rules are tested without a DOM.
import { ARMED_STATUSES, compareTriggerRoster, type TaskRow } from "./triggerTasks";

// Pills the collapsed row shows before folding the rest into "+N".
const MAX_PILLS = 4;

// What the strip shows: every ARMED trigger (plus a live loop), in roster
// order. With nothing armed, fall back ONLY to a trigger this conversation is
// a RUN of: that provenance explains why the session exists, forever. A
// finished trigger on its home shows nothing: the injected turns already
// render inline, and a dead strip on a live session is noise.
export function liveTriggersFor(
  matched: TaskRow[],
  loopRow: TaskRow | null,
  conversationId: string,
  sessionId?: string | null,
  agentTaskId?: string | null,
): TaskRow[] {
  const armed = matched.filter((t) => ARMED_STATUSES.has(t.status)).sort(compareTriggerRoster);
  if (loopRow) armed.push(loopRow);
  if (armed.length > 0) return armed;
  const runOf = matched
    .filter((t) => isRunOf(t, conversationId, sessionId, agentTaskId))
    .sort((a, b) => (b.last_run_at ?? b.created_at) - (a.last_run_at ?? a.created_at))[0];
  return runOf ? [runOf] : [];
}

// The pills the collapsed set row draws: all of them up to MAX_PILLS, else
// the first few and a "+N", and the focused trigger always keeps its pill.
export function pillsShown(live: TaskRow[], focused: TaskRow | undefined): TaskRow[] {
  const shown = live.length > MAX_PILLS ? live.slice(0, MAX_PILLS - 1) : live;
  return focused && !shown.includes(focused) ? [...shown.slice(0, -1), focused] : shown;
}

// True when the viewed conversation is a spawned RUN of the trigger. An inject
// trigger's runs land in its own home, which is the trigger's home, not a run.
export function isRunOf(t: TaskRow, conversationId: string, sessionId?: string | null, agentTaskId?: string | null): boolean {
  return (
    t.originating_conversation_id !== conversationId &&
    ((!!agentTaskId && t._id === agentTaskId) ||
      t.last_run_conversation_id === conversationId ||
      (!!sessionId && t.last_run_session_uuid === sessionId))
  );
}
