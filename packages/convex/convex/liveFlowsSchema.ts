// A live flow (doc s975wwqd8hdn81affbf2jvygpn8gvvt4, liveFlows.ts): a
// team's flow switched on, fed by its sources, with one queue ranked by
// score that the sweep admits from. One row per live flow; no role holds a
// copy. Its runs still start as the lead of each problem's area (seat,
// spawner, placement), and its watcher only answers asks.

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const liveFlowTables = {
  live_flows: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    workflow_id: v.id("workflows"),
    // The finding sources it takes; absent takes every source.
    sources: v.optional(v.array(v.string())),
    // A person's switch only (setOn, from the web): no token or agent flips it.
    on: v.boolean(),
    // The leads whose lines were on when the flow took over their admission:
    // the human state it started from (createLiveFlowCore).
    carried_lines_on: v.optional(v.array(v.string())),
    caps: v.optional(v.object({ hands_per_day: v.optional(v.number()) })),
    counters: v.optional(v.object({ day: v.string(), hands: v.number() })),
    // A timed hold (liveFlows.holdCore): admission starts nothing until
    // `until`, for `why`. A hand or the watcher sets it on a wait no person
    // has to answer (a spent budget until it rolls over); a person clears it.
    // `by` names who set it: a session's short id, or a user.
    hold: v.optional(v.object({ why: v.string(), until: v.number(), by: v.string(), at: v.number() })),
    watcher_role_id: v.optional(v.id("org_roles")),
    // The web's optimistic row for a flow started there (startLiveFlowCore): its id, so the real row supersedes it.
    client_key: v.optional(v.string()),
    changed_by: v.id("users"),
    changed_at: v.number(),
    created_at: v.number(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_team", ["team_id"]),
};
