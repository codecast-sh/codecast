// The publishing session of a published page, as the page and the thread show
// it: one quiet chip. Decided once, on the server (?meta=1's agent.chip), so
// the in-page bar and the conversation embed cannot read the same state apart.

export type PageAgentChip = "idle" | "working" | "updating" | "needs_input";

export const PAGE_AGENT_LABELS: Record<PageAgentChip, string> = {
  idle: "Agent idle",
  working: "Agent working",
  updating: "Agent is updating",
  needs_input: "Agent needs input",
};

// A send the agent has not picked up yet still reads as "updating" this long,
// so the chip does not drop back to idle in the gap before the turn starts.
export const PAGE_AGENT_PICKUP_MS = 90_000;

/** state: the session's work state. awaitingSince: the newest send to the
 *  agent that no newer version has answered (null once one lands). */
export function pageAgentChip(state: string, awaitingSince: number | null, now: number): PageAgentChip {
  if (state === "needs_input") return "needs_input";
  if (awaitingSince !== null && (state === "working" || now - awaitingSince < PAGE_AGENT_PICKUP_MS)) return "updating";
  return state === "working" ? "working" : "idle";
}
