import { Id } from "./_generated/dataModel";

// The immutable AUTHOR (initiator) of a session — who or what started it. This
// is the first of a session's three independent ownership axes; unlike owners
// (a mutable set) and device (movable), the author is fixed at birth and never
// changes, even when the session is reassigned or reparented across users.
//
// There is no denormalized `author` field: the three cases are already recorded
// by distinct pointers written at/after creation, so we derive the author from
// them. Precedence is most-specific-initiator-first — a scheduled run is
// authored by its SCHEDULE, a spawned session by its PARENT session, and
// everything else by the PERSON whose account created it. resolveInitiatorRef is
// pure so queries, enrichment, and the CLI share one definition.
export type InitiatorRef =
  | { kind: "user"; user_id: Id<"users"> }
  | { kind: "schedule"; agent_task_id: Id<"agent_tasks"> }
  | { kind: "session"; conversation_id: Id<"conversations"> };

export function resolveInitiatorRef(conv: {
  user_id: Id<"users">;
  agent_task_id?: Id<"agent_tasks"> | null;
  spawned_by_conversation_id?: Id<"conversations"> | null;
}): InitiatorRef {
  if (conv.agent_task_id) return { kind: "schedule", agent_task_id: conv.agent_task_id };
  if (conv.spawned_by_conversation_id)
    return { kind: "session", conversation_id: conv.spawned_by_conversation_id };
  return { kind: "user", user_id: conv.user_id };
}
