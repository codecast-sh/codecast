// Single source of truth for the coarse "what is this session doing" label used
// by CLI discovery and the `cast monitor` dashboard. Mirrors the WorkState
// outputs of convex/inboxFilters.ts computeWorkState / classifyWorkState:
//   - "working":     the agent is actively producing, has deliverable queued
//                    work, or a just-sent user message it hasn't picked up.
//   - "needs_input": the ball is in the user's court — a finished turn waiting
//                    to be read, an open question / permission prompt, or a dead
//                    session with output (matches the web inbox's NEEDS INPUT).
//   - "idle":        nothing to act on: blank sessions with no messages yet.
//
// PURE isomorphic data — safe to import from the Convex runtime, the daemon, and
// the browser.
export const WORK_STATES = ["working", "needs_input", "idle"] as const;

export type WorkState = (typeof WORK_STATES)[number];
