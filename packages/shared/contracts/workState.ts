// Single source of truth for the coarse "who acts next on this session" label
// used by CLI discovery, the `cast monitor` dashboard, and the web inbox's
// sections. Mirrors the WorkState outputs of convex/inboxFilters.ts
// classifyWorkState:
//   - "working":     the agent is actively producing, has deliverable queued
//                    work, or a just-sent user message it hasn't picked up.
//   - "needs_input": the ball is in the user's court to UNBLOCK — an open
//                    question / permission prompt, an error, a dead session
//                    with output, or a finished turn the agent did not classify.
//   - "done":        the agent delivered and declared the task complete (or a
//                    classifier judged the settle so). Nothing is stalled; the
//                    human reads it at leisure.
//   - "dormant":     parked on a machine wake — an armed trigger, an open
//                    Monitor / background task, or a declared wait. Nothing is
//                    the human's to do until the wake lands.
//   - "idle":        nothing to act on: blank sessions with no messages yet, and
//                    killed sessions (the user already retired them, so no
//                    stale queued work or revived worker can make them look busy).
//
// PURE isomorphic data — safe to import from the Convex runtime, the daemon, and
// the browser.
export const WORK_STATES = ["working", "needs_input", "done", "dormant", "idle"] as const;

export type WorkState = (typeof WORK_STATES)[number];

// The settled-with-content states: the agent's turn is over and the row rests
// in one of these until something wakes it. Everything else is either in
// motion ("working") or empty/retired ("idle").
export const REST_WORK_STATES: ReadonlySet<string> = new Set<string>(["needs_input", "done", "dormant"]);
