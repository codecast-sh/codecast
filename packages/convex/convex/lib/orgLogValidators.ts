// Validators shared by the org log and org proposal tables in schema.ts.
import { v } from "convex/values";

// The record an org log row is about (OrgLogSubject): on the log row, and on
// the copy a proposal change keeps of what its accept moved.
export const orgLogSubjectValidator = v.object({
  type: v.union(v.literal("role"), v.literal("project"), v.literal("plan"), v.literal("task"), v.literal("session"), v.literal("initiative")),
  id: v.string(),
  short_id: v.optional(v.string()),
  label: v.string(),
});

// A person's answer (S39, OrgChangeReply): approve, reject or a note, with
// their words, so a card says it after a reload and on another device. On a
// proposal change row, and on the proposal row for a note on the whole.
export const orgChangeReplyValidator = v.object({
  verdict: v.union(v.literal("approve"), v.literal("reject"), v.literal("note")),
  text: v.optional(v.string()),
  at: v.number(),
  by: v.optional(v.id("users")),
});
