import { canSessionBecomeAgent, fromConvexAgentType, pinnedLaunchOptions, cloudAgentProviderOfConversation, type ConvexAgentType } from "@codecast/shared/contracts";

// ── Moving a session ──────────────────────────────────────────────────────────
//
// Three verbs, each one calm row on the main panel that slides to a list of
// agents written out in full (icon, name, and the reason when one is not
// available). A list reads in one pass; a grid of icons has to be decoded.

export interface AgentOption {
  type: ConvexAgentType;
  label: string;
  /** Why the row is unavailable; unset = pickable. */
  disabledReason?: string;
  /** The session's current agent: ringed, so the list says where you are. */
  current?: boolean;
}

export type MoveVerb = "switch" | "fork" | "handoff";

export const MOVE_VERBS: Record<MoveVerb, { label: string; hint: string }> = {
  switch: { label: "Switch agent", hint: "Same session, another agent" },
  fork: { label: "Fork as", hint: "A copy of this session on another agent" },
  handoff: { label: "Hand off to", hint: "A fresh session, seeded with a brief" },
};

/**
 * Whether a session can become another agent in place: never a cloud agent's,
 * which runs on the provider's machines (fork and hand off still start a new
 * session from it). Every surface that offers "Switch agent" asks this.
 */
export function canSwitchSessionAgent(agentType: string | undefined, sessionId: string | null | undefined, model: string | null | undefined): boolean {
  return !cloudAgentProviderOfConversation(agentType, sessionId, model);
}

/** The move verbs a session offers. */
export function sessionMoveVerbs(agentType: string | undefined, sessionId: string | null | undefined, model: string | null | undefined): MoveVerb[] {
  return (Object.keys(MOVE_VERBS) as MoveVerb[]).filter((verb) => verb !== "switch" || canSwitchSessionAgent(agentType, sessionId, model));
}

/** The agent list for each verb from one session state: the viewer's pinned
 *  agents (users.pinned_agents) plus the current one. Exported for tests. */
export function moveAgentOptions(agentType: string | undefined, messageCount: number | undefined, pins?: readonly string[] | null): Record<MoveVerb, AgentOption[]> {
  const current = (agentType || "claude_code") as ConvexAgentType;
  const count = messageCount ?? 0;
  // Short, because it sits at the end of a row: the count is on the badge already.
  const cannotRebuild = "can't rebuild history";
  const all = pinnedLaunchOptions(pins, fromConvexAgentType(current)).map((a) => ({ type: a.convexType, label: a.label }));
  return {
    switch: all.map<AgentOption>((a) =>
      a.type === current
        ? { ...a, current: true, disabledReason: "current" }
        : canSessionBecomeAgent(a.type, count) ? a : { ...a, disabledReason: cannotRebuild },
    ),
    fork: all.filter((a) => a.type !== current).map<AgentOption>((a) =>
      canSessionBecomeAgent(a.type, count) ? a : { ...a, disabledReason: cannotRebuild },
    ),
    handoff: all.map<AgentOption>((a) => (a.type === current ? { ...a, current: true } : a)),
  };
}
