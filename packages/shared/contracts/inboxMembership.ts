// Inbox membership identity: which rows can be their own inbox member, which
// roll up to a parent, and which pending asks lift a session. Split out of
// inboxProjection.ts, which re-exports it.

// Lifted from convex/inboxFilters.ts so the server scan and every replica run
// ONE implementation (design C4); convex re-exports these back.
export const NOISE_TITLE_PREFIXES = ["[Using:", "[Request", "[SUGGESTION MODE:"] as const;

export function isNoiseTitle(title: string | null | undefined): boolean {
  const t = title?.trim() || "";
  if (!t) return false;
  if (t.toLowerCase() === "warmup") return true;
  return NOISE_TITLE_PREFIXES.some((p) => t.startsWith(p));
}

// A row that can never be its own projection member: subagents, workflow subs,
// and rows with a parent pointer but no parent message (orphans). Their state
// surfaces only on the parent (asking rollup, producing grace). The exception
// is a nested row the person ADOPTED (inbox_adopted_at): they talked to it
// (a flow station opened from its decision, or a message they sent it), so it
// stands alone in their inbox like any session instead of riding a parent
// they never see (a flow's run log is never listed).
export interface InboxRowIdentity {
  /** The owners model applies to the row (shared underOwnersModel). */
  owners_model?: boolean | null;
  is_subagent?: boolean | null;
  is_workflow_sub?: boolean | null;
  parent_conversation_id?: unknown;
  parent_message_uuid?: string | null;
  inbox_adopted_at?: number | null;
}

// A workflow run's own log: the conversation a run opens for itself to carry
// its step events (is_workflow_primary, born with the run). Nobody talks in it
// and its record lives on the run page, so it is never a row in any list a
// person browses (inbox, feed, search); a direct link still opens it. Its
// session id is no marker: born wf-<runId>, the daemon can rebind it to a real
// one. A person's own session that hosts a run carries the run pointer
// (workflow_run_id) only, never the flag (unmarkRunHosts repaired the old ones).
export interface RunLogIdentity {
  is_workflow_primary?: boolean | null;
  workflow_run_id?: unknown;
}

export function isRunLog(conv: RunLogIdentity): boolean {
  return !!conv.is_workflow_primary && !!conv.workflow_run_id;
}

/** Nested by identity (a subagent, a workflow sub, an orphan), adopted or not. */
export function isNestedIdentity(conv: InboxRowIdentity): boolean {
  if (conv.is_subagent === true) return true;
  if (conv.is_workflow_sub === true) return true;
  if (conv.parent_conversation_id && !conv.parent_message_uuid) return true;
  return false;
}

/** A nested row the person adopted: it stands alone (InboxRowIdentity). */
export function isAdoptedChild(conv: InboxRowIdentity): boolean {
  return !!conv.inbox_adopted_at && isNestedIdentity(conv);
}

// Under the owners model (team feature session_owners) nothing rides a parent:
// a nested row belongs to whoever owns it, and the row is a member of exactly
// its owners' inboxes, standing on its own facts. The server stamps
// owners_model only on a row the model applies to: that IS the marker.
export function underOwnersModel(row: { owners_model?: boolean | null }): boolean {
  return row.owners_model === true;
}

export function isOrphanOrSubagent(conv: InboxRowIdentity): boolean {
  return isNestedIdentity(conv) && !conv.inbox_adopted_at && !underOwnersModel(conv);
}

// The parent a child's state rolls up to (its open ask lifts the parent into
// QUESTIONS; its producing status parks the settled parent). ONE rule for the
// server pool grouping (groupPoolChildren) and the replica's asking
// derivation, so a parent can never be lifted on one side only:
//   - a row that is never its own member (isOrphanOrSubagent) rolls up to its
//     parent_conversation_id;
//   - a plan handoff (parent pointer + parent message, not a subagent) is its
//     own member and speaks for itself — no rollup;
//   - an agent-team teammate (spawned_by + agent_team_name, no parent pointer)
//     is its own member AND rolls up to its lead: the lead card is where the
//     team's asks surface.
export interface RollupRow extends InboxRowIdentity {
  spawned_by_conversation_id?: unknown;
  agent_team_name?: string | null;
  agent_name?: string | null;
  /** The role this session reports to (a role's session). */
  org_role_id?: unknown;
  /** Set when the row IS a role's standing session. */
  standing_role_id?: unknown;
  /** A nested child of this row is live (the overlay's child_live fact). */
  child_live?: boolean | null;
  /** The role put this session in front of the person; it stands alone again. */
}

export function rollupParentIdOf(row: RollupRow): string | null {
  if (underOwnersModel(row)) return null;
  if (row.parent_conversation_id) {
    return isOrphanOrSubagent(row) ? String(row.parent_conversation_id) : null;
  }
  if (row.agent_team_name && row.agent_name !== "team-lead" && row.spawned_by_conversation_id) return String(row.spawned_by_conversation_id);
  return null;
}

// Whether a pending `cast decide` row lifts its session into QUESTIONS (and
// counts in the queue, its badge and /questions). ONE rule for the server's
// pending-decide set and the replica's, so a session is never lifted on one
// side only. A blocking ask parks its session, so it waits on a person. An
// advisory ask does not: the agent is already working on its default, so it
// stays inside its own session and never interrupts. The exception is a row
// someone filed into a named stack on purpose, which is where "answer all
// defaults" resolves advisories.
export interface StackedAskRow {
  status: string;
  blocking?: boolean;
  stack_id?: unknown;
}

export function isStackedAsk(d: StackedAskRow): boolean {
  return d.status === "pending" && (!!d.blocking || !!d.stack_id);
}

// Whether an answered advisory ask still takes a person's answer. The agent
// went ahead on its default the moment it asked, so an answer on record (its
// default applied by a stack policy, or a person's earlier pick) is a course
// it is already on, and a person may still change it: the new answer reaches
// the agent as one more message. A blocking ask, a gate on a run (its run
// already routed on the answer) and a role's answer under a grant (reopened
// through its own path) stay settled. ONE rule for the dispatch guard, the
// server's settle hook and the web store, so no rail accepts what another
// refuses.
export interface AdvisoryAnswerRow {
  status: string;
  blocking?: boolean;
  workflow_run_id?: unknown;
  answered_by?: { kind: string } | null;
}

export function advisoryAnswerOpen(d: AdvisoryAnswerRow): boolean {
  return d.status === "answered" && d.blocking === false && !d.workflow_run_id && d.answered_by?.kind !== "role";
}

// ── The owners model (team feature session_owners) ─────────────────────────
//
// Under the flag a session is in the inbox of exactly its owners, and an agent
// owner (its role, or the session that started it) answers its waits. The
// server stamps the owners fields on an inbox row only when the model applies
// to it (enrichInboxSessionRow), so `owners_model` IS the marker: a row
// without it places and lists exactly as before the flag. Every replica and
// the server read these few row fields, never the flag itself. A row carries
// no owner list: whether it is the viewer's is owned_by_me (an owner row of
// theirs, or a wait that escalated to them), or their being its implicit
// starter. Who else owns it is the owners read (sessionOwnership listOwnersFor).
export interface OwnersModelRow {
  /** The model applies to this row (the session's team, or its runner's, has session_owners). */
  owners_model?: boolean | null;
  /** The viewer holds an owner row (stampInboxViewerFields). */
  owned_by_me?: boolean | null;
  /** The person who owns it only because nothing else does (shared ownersOf implicitStarter). */
  implicit_owner?: string | null;
  /** The role that owns it. */
  org_role_id?: unknown;
  /** The session that owns it: the one that started it, until released. */
  owner_session_id?: unknown;
  /** When its current wait reached its people (server time): the agent owner could not be told, or passed it up. */
  wait_up_at?: number | null;
  /** The message count that wait was at: a later message is the next turn, which hands the waits back to the agent. */
  wait_up_count?: number | null;
  /** Who the wait reached when no person owns it (shared waitAudience): the human who started it, or the person its role's line ends at. */
  wait_up_person?: string | null;
  message_count?: number | null;
  /** The person's own filing (the replica's spelling, current per userRestOf). */
  user_rest?: string | null;
  /** The waiting episode the needs-input push last covered: "<message_count>:<kind>" (escalatedAsks). */
  needs_input_notified_key?: string | null;
}

/** The current wait reached the people: stamped, and no message since. A
 *  count, not a clock, so the server's stamp and a machine's message times
 *  never meet in one comparison. */
export function waitReachedPeople(row: OwnersModelRow): boolean {
  return row.wait_up_count != null && (row.message_count ?? 0) <= row.wait_up_count;
}

/** The current escalation is an ask the person answers in place: a
 *  permission prompt or an open question. Read off the waiting episode's own
 *  key (needs_input_notified_key, "<message_count>:<kind>"), which the
 *  needs-input push and the daemon's permission push both write for the
 *  episode they cover, so a row the escalated window seats, which reads no
 *  liveness, still files under questions. Only an episode at the row's
 *  current message count counts. */
export function escalatedAsks(row: OwnersModelRow): boolean {
  if (!underOwnersModel(row) || !waitReachedPeople(row) || !row.needs_input_notified_key) return false;
  const sep = row.needs_input_notified_key.indexOf(":");
  const count = Number(row.needs_input_notified_key.slice(0, sep));
  const kind = row.needs_input_notified_key.slice(sep + 1);
  return count === (row.message_count ?? 0) && (kind === "permission_blocked" || kind === "awaiting_input");
}

/** The stamps to clear once a message follows an escalation: it has ended
 *  (waitReachedPeople), so its person's inbox and the escalation index drop
 *  it. Empty while it stands or when there is none. */
export function endedEscalationPatch(conv: { wait_up_count?: number | null }, messageCount: number): Record<string, undefined> {
  return conv.wait_up_count != null && messageCount > conv.wait_up_count
    ? { wait_up_at: undefined, wait_up_count: undefined, wait_up_person: undefined }
    : {};
}

/** The row is in the viewer's inbox under the model: they hold an owner row,
 *  they own it as its implicit starter, or its current wait reached them
 *  (read off the row, so the next message drops it at once on every
 *  replica). */
export function isInboxMember(row: OwnersModelRow, viewerId: string | { toString(): string } | null | undefined): boolean {
  if (!viewerId || !underOwnersModel(row)) return false;
  const me = viewerId.toString();
  return !!row.owned_by_me || String(row.implicit_owner ?? "") === me
    || (String(row.wait_up_person ?? "") === me && waitReachedPeople(row));
}

export type InboxAgentOwner = { kind: "role"; id: string } | { kind: "session"; id: string };

/** The agent that owns the row under the model: its role, else the session
 *  that started it. Null off the model or with no agent owner. */
export function agentOwnerOfRow(row: OwnersModelRow): InboxAgentOwner | null {
  if (!underOwnersModel(row)) return null;
  if (row.org_role_id) return { kind: "role", id: String(row.org_role_id) };
  if (row.owner_session_id) return { kind: "session", id: String(row.owner_session_id) };
  return null;
}

/** An agent owner answers what this row waits on: it files under working
 *  ("With <owner>") and rings nobody, until the wait reaches its people. */
export function agentAnswersRow(row: OwnersModelRow): boolean {
  return !!agentOwnerOfRow(row) && !waitReachedPeople(row);
}
