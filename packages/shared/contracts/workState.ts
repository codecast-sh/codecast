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

// Accepted `--state` filter values for CLI discovery, normalized to a canonical
// token. "pinned" and "live" are orthogonal to work_state (they filter the
// is_pinned / is_live flags), so callers handle them specially. Returns null for
// "all"/unset/garbage: the server reads that as "no filter", so the CLI checks a
// typed value against WORK_STATE_FILTERS first and refuses one that means nothing.
export type WorkStateFilter = WorkState | "pinned" | "live" | "hibernated";

/** The canonical spellings a `--state` flag lists in its help and errors. */
export const WORK_STATE_FILTERS = ["needs-input", "done", "working", "dormant", "hibernated", "idle", "pinned", "live"] as const;

export function normalizeWorkStateFilter(raw: string | undefined | null): WorkStateFilter | null {
  const v = (raw || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  switch (v) {
    case "working":
    case "active":
    case "busy":
      return "working";
    case "needs-input":
    case "needs":
    case "needsinput":
    case "blocked":
    case "input":
    case "attention":
      return "needs_input";
    case "done":
    case "complete":
    case "completed":
    case "delivered":
      return "done";
    // "waiting" is the agent_status of a finished turn parked on live background
    // work — a settle verdict, so the filter alias follows it to dormant.
    case "dormant":
    case "waiting":
    case "parked":
    case "asleep":
      return "dormant";
    case "idle":
    case "blank":
      return "idle";
    case "hibernated":
      return "hibernated";
    case "pinned":
    case "pin":
      return "pinned";
    case "live":
    case "running":
      return "live";
    default:
      return null;
  }
}
