// A project's expectations (docs/architecture/the-line-model.md LM5) and the
// proposals that change them. Shapes: @codecast/shared/contracts/expectations.
//
// Access is the project's: `workspace` is copied from the project row at
// write time and every read checks the project itself (canAccessProject), so
// a person reads a project's expectations exactly when they read the project.
// team_id is routing only.
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { CITATION_KINDS } from "@codecast/shared/contracts/expectations";

const citation = v.object({
  kind: v.union(...CITATION_KINDS.map((k) => v.literal(k))),
  ref: v.string(),
  quote: v.optional(v.string()),
  when: v.optional(v.string()),
});

export const expectationValidator = v.object({
  id: v.string(),
  text: v.string(),
  part: v.string(),
  status: v.union(v.literal("active"), v.literal("retired")),
  note: v.optional(v.string()),
  citations: v.array(citation),
  retired_reason: v.optional(v.string()),
  added_in: v.number(),
  changed_in: v.number(),
});

export const expectationOpValidator = v.union(
  v.object({ op: v.literal("add"), text: v.string(), part: v.string(), note: v.optional(v.string()), citations: v.array(citation), status: v.optional(v.union(v.literal("active"), v.literal("retired"))), reason: v.optional(v.string()) }),
  v.object({ op: v.literal("edit"), id: v.string(), text: v.optional(v.string()), part: v.optional(v.string()), note: v.optional(v.string()), citations: v.array(citation) }),
  v.object({ op: v.literal("retire"), id: v.string(), reason: v.string(), citations: v.array(citation) }),
);

export const expectationTables = {
  // One row per version of a project's document, never rewritten: the
  // current document is the highest version, and a judge's version stays
  // readable for as long as its findings are.
  project_expectations: defineTable({
    project_id: v.id("projects"),
    user_id: v.id("users"), // who applied it
    team_id: v.optional(v.id("teams")),
    workspace: v.string(),
    version: v.number(),
    // ex-<prefix>-<n>: fixed by version 1, so ids stay stable when the
    // project is renamed. next_n is the number the next added line takes.
    prefix: v.string(),
    next_n: v.number(),
    items: v.array(expectationValidator),
    summary: v.string(),
    how: v.union(v.literal("person"), v.literal("auto")),
    proposal_id: v.optional(v.id("expectation_proposals")),
    created_at: v.number(),
  })
    .index("by_project_version", ["project_id", "version"])
    .index("by_workspace_prefix", ["workspace", "prefix"]),

  // A proposed change (xp-N): additions, edits and retirements, each with
  // its sources, written against one version. Applied by a person (the CLI,
  // or the card it put in their queue), or on its own when it only adds
  // lines in a person's own quoted words (shared/contracts autoApplies). `since`/`until` are the window of team context it was
  // read from: the routine's cursor is the newest `until`.
  expectation_proposals: defineTable({
    short_id: v.string(),
    project_id: v.id("projects"),
    user_id: v.id("users"), // the account that proposed
    team_id: v.optional(v.id("teams")),
    workspace: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    summary: v.string(),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
    base_version: v.number(),
    ops: v.array(expectationOpValidator),
    // empty: a harvest that found nothing to change; it still moves the cursor.
    // retracted: a proposal that should never have been made (a run outside
    // the routine), withdrawn by an operator with the reason; it moves no
    // cursor, so the next pass reads its window again.
    status: v.union(v.literal("open"), v.literal("applied"), v.literal("dropped"), v.literal("empty"), v.literal("retracted")),
    retracted_reason: v.optional(v.string()),
    decision_id: v.optional(v.id("session_decisions")),
    applied_version: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
    resolved_at: v.optional(v.number()),
    // Why an applied answer could not land (the document moved under it).
    refused: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_project_created", ["project_id", "created_at"])
    .index("by_short_id", ["short_id"])
    .index("by_decision", ["decision_id"]),
};
