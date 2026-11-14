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

export function isOrphanOrSubagent(conv: InboxRowIdentity): boolean {
  return isNestedIdentity(conv) && !conv.inbox_adopted_at;
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
