// Which row a session list nests under which (Task subagents, agent-team
// teammates, a role's sessions, spawned workers), kept out of inboxStore. The
// phone bundle reaches this file: relative imports only, and only types from
// the store, which imports this module.
import { isUnderRole, roleLeadIdsOf, underOwnersModel } from "@codecast/shared/contracts";
import { isAgentTeamWorker, isSubagentConversation, nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import type { InboxSession } from "./inboxStore";

// Subagent/teammate rows never float at their own slot in a flat list — they
// render directly under their parent whenever the parent is in the list. The
// view comparator places a child wherever ITS OWN activity lands, which strands
// it between unrelated cards while its (recently-active) parent sorts far away
// — three ↳-styled rows adrift in the middle of the inbox. Children keep the
// comparator's relative order among siblings and follow chains (a child's own
// children ride along). A teammate whose lead didn't make the list is dropped
// (dropOrphanSubagents), same as a parentless Task subagent — leftover
// reviewers must not become their own Done cards.
export function hoistNestedUnderParent(list: InboxSession[], nestWorkers = false): InboxSession[] {
  const present = new Set(list.map((s) => s._id));
  const nestParentOf = inboxNestParentOf(list, nestWorkers);
  const nestedHere = (s: InboxSession) => {
    const p = nestParentOf(s);
    return p && p !== s._id && present.has(p) ? p : null;
  };
  const kidsByParent = new Map<string, InboxSession[]>();
  for (const s of list) {
    const p = nestedHere(s);
    if (!p) continue;
    if (!kidsByParent.has(p)) kidsByParent.set(p, []);
    kidsByParent.get(p)!.push(s);
  }
  if (kidsByParent.size === 0) return list;
  const out: InboxSession[] = [];
  const emitted = new Set<string>();
  const emit = (s: InboxSession) => {
    if (emitted.has(s._id)) return;
    emitted.add(s._id);
    out.push(s);
    for (const kid of kidsByParent.get(s._id) ?? []) emit(kid);
  };
  for (const s of list) if (!nestedHere(s)) emit(s);
  // A parent-link cycle would leave its members un-emitted above (each waits on
  // the other) — append them in sort order rather than dropping rows.
  for (const s of list) emit(s);
  return out;
}

export function nestedSessionIds(subsByParent: Map<string, InboxSession[]>): Set<string> {
  const ids = new Set<string>();
  for (const sessions of subsByParent.values()) {
    for (const session of sessions) ids.add(session._id);
  }
  return ids;
}

// Drop Task subagents and team workers whose nest parent didn't make `list`
// (see flatViewSessions). The focused row always renders; a pinned one is an
// explicit "keep visible". A spawned worker (isSpawnedWorker) is never dropped:
// it nests only while its spawner is listed, and otherwise stands as its own
// row, so a worker cannot vanish with a parent that aged out or was set aside.
export function dropOrphanSubagents(list: InboxSession[], focusedId?: string | null, nestWorkers = false): InboxSession[] {
  const present = new Set(list.map((s) => s._id));
  const nestParentOf = inboxNestParentOf(list, nestWorkers);
  return list.filter((s) => {
    if (s._id === focusedId || s.is_pinned) return true;
    // Under the owners model nothing nests: a listed row is one the viewer owns.
    if (underOwnersModel(s)) return true;
    // A role's session is a subagent of the role's card.
    if (!isSubagentConversation(s) && !isAgentTeamWorker(s) && !isUnderRole(s)) return true;
    const p = nestParentOf(s);
    return !!p && p !== s._id && present.has(p);
  });
}

// Which row a session nests under in a session list, over the rows present:
// the shared child kinds (nestParentIdOf: a Task subagent, an agent-team
// teammate) and a role's session under its role's standing session
// (isUnderRole, org-roles-run-work.md R1). The ONE resolver every web nesting
// computation calls, so the sections, the flat view, the set aside buckets and
// the keyboard order cannot disagree about where a role's session sits.
//
// A third kind nests here for DISPLAY only: a session an agent spawned
// (isSpawnedWorker: a `cast spawn` worker, a workflow sub). The shared
// nestParentIdOf deliberately leaves those first-class, because the server
// (kill cascade, org counts, revive) must keep treating them as their own
// sessions; the web list alone folds them under the session that spawned them.
// A workflow sub's parent is the run's host: the present row on the same run
// that is neither a sub nor the run's own log.
export function inboxNestParentOf(rows: Iterable<InboxSession>, nestWorkers = false): (s: InboxSession) => string | null {
  const byId = new Map<string, InboxSession>();
  for (const r of rows) byId.set(r._id, r);
  const roleLeads = roleLeadIdsOf(byId.keys(), (id) => byId.get(id));
  let runHosts: Map<string, string> | null = null;
  const runHostOf = (runId: string) => {
    if (!runHosts) {
      runHosts = new Map();
      for (const r of byId.values()) {
        if (r.workflow_run_id && !r.is_workflow_sub && !r.is_workflow_primary && !runHosts.has(r.workflow_run_id)) runHosts.set(r.workflow_run_id, r._id);
      }
    }
    return runHosts.get(runId) ?? null;
  };
  return (s) => {
    // Under the owners model a row stands alone in its owners' inboxes; a
    // child its session owns rides that card by owner_session_id
    // (ownedChildrenOf), never by this parent pointer.
    if (underOwnersModel(s)) return null;
    const shared = nestParentIdOf(s);
    if (shared) return shared;
    if (isUnderRole(s)) return s.org_role_id ? roleLeads.get(s.org_role_id) ?? null : null;
    if (!nestWorkers || !isSpawnedWorker(s)) return null;
    const p = s.is_workflow_sub ? runHostOf(s.workflow_run_id!) : s.spawned_by_conversation_id!;
    return p && p !== s._id ? p : null;
  };
}

// A session an agent spawned that the shared nestParentIdOf leaves first-class:
// a `cast spawn` worker (spawned_by, no team) or a workflow sub. Display only
// (see inboxNestParentOf). A spawned session that leads its own team stays a
// card of its own: its teammates nest under it, and a sub row never draws rows
// of its own.
export function isSpawnedWorker(s: InboxSession): boolean {
  if (underOwnersModel(s) || nestParentIdOf(s) || isUnderRole(s)) return false;
  if (s.is_workflow_sub) return !!s.workflow_run_id;
  if (!s.spawned_by_conversation_id) return false;
  return !(s.agent_team_name && s.agent_name === "team-lead");
}
