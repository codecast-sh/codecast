// When a Claude Code subagent counts as producing on its own output alone, with
// no session of its own to report: the server's parent park (convex
// inboxFilters subagentIsProducing) and the web's card state read this one test.

// Output this recent: producing.
export const SUBAGENT_PRODUCING_GRACE_MS = 5 * 60 * 1000;

// How long one open tool call keeps it producing with no output (a long test
// run syncs nothing until it returns; p90 10 min, p99 39 min over 939 subagents
// on 2026-11-26). Capped: a child that died mid-call leaves the call open.
export const SUBAGENT_TOOL_CALL_CAP_MS = 20 * 60 * 1000;

// When the child's newest message is a tool call still waiting on its result:
// the activity stamp comes from that call and nothing has synced since (a
// result or any later message moves updated_at past it). Null otherwise.
export function openToolCallAt(c: { last_message_role?: string | null; activity?: { at: number } | null; updated_at: number }): number | null {
  return c.last_message_role === "assistant" && c.activity && c.activity.at >= c.updated_at ? c.activity.at : null;
}

/** Recent output, or one open tool call younger than the cap. */
export function producingByOutput(c: { last_message_role?: string | null; activity?: { at: number } | null; updated_at: number }, now: number): boolean {
  if (now - c.updated_at < SUBAGENT_PRODUCING_GRACE_MS) return true;
  const at = openToolCallAt(c);
  return at != null && now - at < SUBAGENT_TOOL_CALL_CAP_MS;
}
