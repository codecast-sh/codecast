import { ArrowRightLeft, Split, Send } from "lucide-react";
import { AGENT_LAUNCH_OPTIONS, canSessionBecomeAgent, type ConvexAgentType } from "@codecast/shared/contracts";

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

export const MOVE_VERBS: Record<MoveVerb, { label: string; hint: string; icon: typeof Split }> = {
  switch: { label: "Switch agent", hint: "Same session, another agent", icon: ArrowRightLeft },
  fork: { label: "Fork as", hint: "A copy of this session on another agent", icon: Split },
  handoff: { label: "Hand off to", hint: "A fresh session, seeded with a brief", icon: Send },
};

/** The agent list for each verb from one session state. Exported for tests. */
export function moveAgentOptions(agentType: string | undefined, messageCount: number | undefined): Record<MoveVerb, AgentOption[]> {
  const current = (agentType || "claude_code") as ConvexAgentType;
  const count = messageCount ?? 0;
  // Short, because it sits at the end of a row: the count is on the badge already.
  const cannotRebuild = "can't rebuild history";
  const all = AGENT_LAUNCH_OPTIONS.map((a) => ({ type: a.convexType, label: a.label }));
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
