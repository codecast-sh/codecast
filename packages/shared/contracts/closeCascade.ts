// What a close of a lead does to the agents under it: which go down with it
// (goesDownWithLead, cascadeTakesDownRow), and which it leaves standing as their
// own cards while they still hold something (closeLeavesStanding and the
// adoption rules). One rule for the server's cascade, its aside scan and
// release (convex cleanup.ts, lib/closeAside, lib/adoptionRelease, dispatch.ts)
// and the web's optimistic close and tooltip (store closeInDraft, lib/sessionClose).
// Kept out of the contracts barrel: the CLI's boot graph never needs it
// (packages/cli bench/bootGraph.guard.test.ts).
import { closeInFlightReason, isClosedSession, type ClosedFields, type InFlightFacts } from "./closedSession";
import { isOrphanOrSubagent } from "./inboxMembership";
import { runsInParentProcess, type RunsInParentFacts } from "./runsInParent";

/** Whether a close of its lead takes this child down with it. Two kinds go:
 *  a child that runs inside the lead's process (runsInParentProcess: a Claude
 *  Code subagent, a codex child running in the lead) and cannot outlive it;
 *  and an agent-team teammate, which is the lead's team (agent_team_name; the
 *  "team-lead" row is the lead itself). Every other spawned child has its own
 *  process and stays up. */
export function goesDownWithLead(row: RunsInParentFacts & { agent_team_name?: string | null; agent_name?: string | null }): boolean {
  if (runsInParentProcess(row)) return true;
  return !!row.agent_team_name && row.agent_name !== "team-lead";
}

/** A child a close of its lead leaves up that would otherwise only ever show
 *  beneath the lead's card: a nested row (a `cast spawn` worker), not already
 *  hidden or adopted. Whether the close adopts it waits on what it still holds
 *  (closeLeavesStanding). */
export function standsApartFromLead(child: ClosedFields & {
  runs_in_parent?: boolean | null;
  session_id?: string | null;
  agent_type?: string | null;
  spawned_by_conversation_id?: unknown;
  cli_flags?: string | null;
  headless_launch?: boolean | null;
  agent_team_name?: string | null;
  agent_name?: string | null;
  inbox_stashed_at?: number | null;
  is_subagent?: boolean | null;
  is_workflow_sub?: boolean | null;
  parent_conversation_id?: unknown;
  parent_message_uuid?: string | null;
  inbox_adopted_at?: number | null;
}): boolean {
  if (goesDownWithLead(child) || !isOrphanOrSubagent(child)) return false;
  return !child.inbox_dismissed_at && !child.inbox_stashed_at && !child.inbox_killed_at;
}

/** What a child left up by its lead's close still holds: anything in flight
 *  (closeInFlightReason), a live process (its heartbeat, rowHeartbeatAliveAt),
 *  or an armed trigger. The web gathers these from the row (lib/sessionClose
 *  holdFactsOfRow), the server from its database (convex lib/closeAside
 *  holdFactsOnServer). */
export type HoldFacts = InFlightFacts & { processAlive: boolean; triggerArmed: boolean };

export function stillHolds(f: HoldFacts): boolean {
  return f.processAlive || f.triggerArmed || closeInFlightReason(f) !== null;
}

/** The close of its lead adopts this child, so it stands in the inbox as its
 *  own card while the lead is closed: it stands apart from the lead and still
 *  holds something. The adoption stamp is the close's own (the lead's
 *  inbox_dismissed_at), which keys it to that close: when the lead comes back
 *  (any clear of its dismissed stamp) or the server sets the close aside
 *  instead, the adoptions carrying that stamp are cleared (adoptedByClose) and
 *  the child nests under the lead again. A child adopted for another reason
 *  keeps its stamp. A finished child is left as it is, nested under the closed
 *  lead, and comes back with it. */
export function closeLeavesStanding(child: Parameters<typeof standsApartFromLead>[0], facts: HoldFacts): boolean {
  return standsApartFromLead(child) && stillHolds(facts);
}

/** How many of a lead's newest children (per link: parent_conversation_id,
 *  spawned_by) a close reads: the server's cascade adopts within it and its
 *  release clears within it (convex lib/closeAside nestedGroupOf), and the web
 *  adopts only within it (closeAdoptionWindow), so a release always covers
 *  what a close adopted. */
export const NESTED_GROUP_SCAN = 200;

/** The ids of the lead's parent-linked children a close may adopt on the
 *  web: the newest NESTED_GROUP_SCAN by creation, the window the server reads. */
export function closeAdoptionWindow(rows: Iterable<{ _id: string; parent_conversation_id?: unknown; _creationTime?: number | null; started_at?: number | null }>, leadId: string): Set<string> {
  const kids: Array<{ _id: string; at: number }> = [];
  for (const r of rows) if (r.parent_conversation_id != null && String(r.parent_conversation_id) === leadId) kids.push({ _id: r._id, at: r._creationTime ?? r.started_at ?? 0 });
  kids.sort((a, b) => b.at - a.at);
  return new Set(kids.slice(0, NESTED_GROUP_SCAN).map((k) => k._id));
}

/** The lead is still in the close stamped `stamp`: closed by it, not brought
 *  back, set aside or killed since. The one test every adoption write of that
 *  close passes (convex cleanup.ts cascade batches); a client's adoption is
 *  never taken as given (dispatch.ts: the server's cascade decides). */
export function leadStillInClose(lead: ClosedFields, stamp: number | null | undefined): boolean {
  return stamp != null && lead.inbox_dismissed_at === stamp && lead.inbox_closed_at === stamp && !lead.inbox_killed_at;
}

/** This child was adopted by the close stamped `closeStamp` (closeLeavesStanding). */
export function adoptedByClose(child: { inbox_adopted_at?: number | null }, closeStamp: number | null | undefined): boolean {
  return closeStamp != null && child.inbox_adopted_at === closeStamp;
}

/** Whether a hide of a lead takes this member of its nested group down: the
 *  one per-child rule the server's cascade, the server's aside scan and the
 *  web's optimistic close all apply (convex cleanup.ts / lib/closeAside, web
 *  store closeInDraft, web lib/sessionClose). A close takes only the members
 *  that go down with the lead (goesDownWithLead); a kill or stash
 *  takes the group as before. `queued`: a message waits for it (the server's
 *  has_pending_messages, the web row's has_pending). */
export function cascadeTakesDownRow(
  child: ClosedFields & { session_id?: string | null; agent_type?: string | null; cli_flags?: string | null; agent_team_name?: string | null; agent_name?: string | null; inbox_stashed_at?: number | null; is_subagent?: boolean | null; parent_conversation_id?: unknown; [k: string]: any },
  field: "inbox_dismissed_at" | "inbox_stashed_at",
  opts: { forceKill?: boolean; close?: boolean; queued: boolean },
): boolean {
  // A stash takes only the members that are inbox rows of their own.
  if (field === "inbox_stashed_at" && isOrphanOrSubagent(child as any)) return false;
  // A close stops only what goes down with the lead. (A close that sets the
  // lead aside is a stash, which takes what a stash takes.)
  if (opts.close && field === "inbox_dismissed_at" && !goesDownWithLead(child)) return false;
  // A quiet re-assert never re-kills.
  if (child[field] && !opts.forceKill) return false;
  // A close leaves a killed member alone (it is retired, nothing of it wakes),
  // and a closed one with nothing queued (already stopped, its wakes kept).
  if (opts.close && child.inbox_killed_at) return false;
  if (opts.close && isClosedSession(child) && !opts.queued) return false;
  return true;
}
