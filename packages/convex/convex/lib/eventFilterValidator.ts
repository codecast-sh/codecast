import { v, type Infer } from "convex/values";

// What an event trigger waits for. One validator, imported by the schema, the
// trigger revisions snapshot and every agentTasks mutation that writes one,
// because five hand-copied v.object literals had to grow a field in lockstep
// each time a filter learned a new narrowing.
//
// event_type is a trigger name (shared/contracts/triggerEvents.ts) or a raw
// webhook kind. repository and pr_number narrow the pull request events;
// source narrows the ingestion events to one event_sources name
// (docs/architecture/external-data.md X4).
export const eventFilterValidator = v.object({
  event_type: v.string(),
  action: v.optional(v.string()),
  repository: v.optional(v.string()),
  pr_number: v.optional(v.number()),
  source: v.optional(v.string()),
});

export type EventFilter = Infer<typeof eventFilterValidator>;

/**
 * The event a firing carried, held on the trigger until a run claims it (X4).
 * Quoted to the run as data, never as instructions: its title is text a
 * product sent.
 */
export const pendingEventValidator = v.object({
  external_event_id: v.optional(v.id("external_events")),
  group_short_id: v.optional(v.string()),
  event_type: v.string(),
  title: v.string(),
  url: v.optional(v.string()),
  at: v.number(),
});

export type PendingEvent = Infer<typeof pendingEventValidator>;
