// The stored shape of a chat round (@codecast/shared/chat rounds.ts), kept on
// the thread root's `round` field. A leaf so schema.ts imports it alone.

import { v } from "convex/values";

const memberState = v.union(
  v.literal("waiting"),
  v.literal("floor"),
  v.literal("spoke"),
  v.literal("passed"),
  v.literal("busy"),
  v.literal("no_answer"),
  v.literal("skipped"),
  v.literal("unreachable"),
  v.literal("out"),
);

export const chatRoundValidator = v.object({
  status: v.union(v.literal("open"), v.literal("done"), v.literal("ended")),
  opened_at: v.number(),
  updated_at: v.number(),
  by_person: v.boolean(),
  lap: v.number(),
  spoke_in_lap: v.boolean(),
  members: v.array(v.object({
    key: v.string(),
    kind: v.union(v.literal("role"), v.literal("session")),
    short_id: v.string(),
    name: v.string(),
    session_id: v.optional(v.string()),
    turns: v.number(),
    state: memberState,
    deferred: v.optional(v.boolean()),
  })),
  queue: v.array(v.string()),
  floor_key: v.optional(v.string()),
  floor_session_id: v.optional(v.string()),
  floor_wake_id: v.optional(v.string()),
  floor_since: v.optional(v.number()),
  last_speaker: v.optional(v.string()),
});
