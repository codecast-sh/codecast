// Single source of truth for the coarse "what is this session doing" label used
// by CLI discovery and the `cast monitor` dashboard. Mirrors the WorkState
// outputs of convex/inboxFilters.ts computeWorkState / classifyWorkState:
//   - "working":     the agent is actively producing, or has deliverable queued work.
//   - "needs_input": blocked on the user, dead with output to read, or a pinned
//                    session that has gone idle.
//   - "idle":        finished, ball in the user's court, not flagged.
//
// PURE isomorphic data — safe to import from the Convex runtime, the daemon, and
// the browser.
export const WORK_STATES = ["working", "needs_input", "idle"] as const;

export type WorkState = (typeof WORK_STATES)[number];
