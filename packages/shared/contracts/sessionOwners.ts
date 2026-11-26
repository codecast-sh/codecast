// Who owns a session under the `session_owners` team feature, as one pure
// rule. The convex owner mutations, the inbox (server scan and client store)
// and the owners menu all read these, so what a client paints before the
// server answers is what the server answers.
//
// A session's owners are:
//   - people: its session_owners rows, in the order they were added;
//   - at most one role: conversations.org_role_id;
//   - its parent session, while not released: the session it is nested under
//     as a worker (parent_conversation_id), until a person takes it over
//     (parent_released_at). A session another one only spawned
//     (spawned_by_conversation_id alone: a plain `cast spawn`, an agent-team
//     teammate) is its peer, never its child, so its spawner never owns it;
//   - its starter, the human who started it, only while it has none of the
//     above, and never when a role started it (role_started).
// An agent owner (the role, else the parent session) answers the session's
// waits. Taking it over removes the agent owner and makes the taker an owner.
// Ids are compared as strings, so Convex ids and plain strings both fit.

import { workspaceFeatureEnabled, type TeamFeatures } from "./teamFeatures";

/**
 * Whether a session follows this model: the `session_owners` flag of the
 * session's own team, never the viewer's. A personal session (no team) follows
 * it when the account that runs it belongs to any team with the flag on.
 * `runnerTeams`: the runner's teams, which include the session's team.
 */
export function ownersModelOn(
  session: { team_id?: unknown },
  runnerTeams: Array<{ _id?: unknown; features?: TeamFeatures | null } | null | undefined>,
): boolean {
  return workspaceFeatureEnabled(runnerTeams, session.team_id ? String(session.team_id) : null, "session_owners");
}

export type OwnerRowFact = { user_id: string; added_at: number };

export type SessionOwnerFacts = {
  /** The session itself, when the caller knows it (an adopt names it to refuse itself). */
  conversation_id?: unknown;
  /** The session's session_owners rows, in any order. */
  rows: OwnerRowFact[];
  /** The human who started it: its author, else its runner, never an agent account. */
  starter: string | null;
  /** conversations.user_id: the account that runs it. */
  user_id?: unknown;
  org_role_id?: unknown;
  parent_conversation_id?: unknown;
  /** Set: the parent no longer owns it (any number, 0 included: a server
   *  reads a deleted or killed parent as released). */
  parent_released_at?: number | null;
  role_started?: boolean | null;
};

export type SessionOwners = {
  people: string[];
  role: string | null;
  parentSession: string | null;
  implicitStarter: string | null;
};

export type AgentOwner = { kind: "role"; id: string } | { kind: "session"; id: string };

export type OwnersChange = {
  /** People to add (user ids). */
  add?: string[];
  /** People to remove (user ids). */
  remove?: string[];
  /** Rows put back as they were (an undo of a remove), so their order returns. */
  restore?: OwnerRowFact[];
  /** A role id replaces the role; null removes it; absent leaves it. */
  role?: string | null;
  /** Release the parent session: it stops owning the session. */
  releaseParent?: boolean;
  /** Take it over: every agent owner comes off (the role, the parent), the
   *  actor becomes an owner, and the session is no longer a role's start. */
  takeOver?: boolean;
  /** Make it the worker of this session (a conversation id): it becomes the
   *  parent session and its agent owner (the role comes off, and it is no
   *  longer a role's start), any release is cleared, and the actor's own
   *  owner row comes off (the drag hands it over) unless the change adds or
   *  restores it; other people's rows stay. With releaseParent it is nested
   *  there already released (an undo putting a released parent back). */
  adoptParent?: string;
  /** Take it out from under any parent: no parent link and no release, as
   *  if it had never worked for one (the undo of an adopt that found none). */
  detachParent?: boolean;
};

const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));

function sortedRows(rows: OwnerRowFact[]): OwnerRowFact[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.added_at - b.r.added_at || a.i - b.i).map(({ r }) => r);
}

/** The session it is nested under as a worker, released or not. A spawner is no parent. */
export function parentLinkOf(row: Pick<SessionOwnerFacts, "parent_conversation_id">): string | null {
  return str(row.parent_conversation_id);
}

export function ownersOf(f: SessionOwnerFacts): SessionOwners {
  const people = [...new Set(sortedRows(f.rows).map((r) => String(r.user_id)))];
  const role = str(f.org_role_id);
  const parentSession = f.parent_released_at != null ? null : parentLinkOf(f);
  const implicitStarter = !people.length && !role && !parentSession && !f.role_started ? f.starter : null;
  return { people, role, parentSession, implicitStarter };
}

/** The agent that answers the session: its role, else its parent session. */
export function agentOwnerOf(f: SessionOwnerFacts): AgentOwner | null {
  const o = ownersOf(f);
  if (o.role) return { kind: "role", id: o.role };
  if (o.parentSession) return { kind: "session", id: o.parentSession };
  return null;
}

/**
 * Who hears a session's wait, ONE rule for the needs-input push and the inbox.
 * A reachable agent owner hears it and nobody is rung. Otherwise the person
 * owners do; failing that the implicit starter; failing that the human who
 * started it (an agent owner that cannot be reached still owns it, so it has
 * no implicit starter); and failing that the person the server resolved
 * (`fallbackPerson`: where the session's role line ends, else a workspace
 * admin). `exclude` names who can never hear it: agent accounts (an owner row
 * can name one) and people who left its team. Nobody only when nobody is left
 * at all. `person` is the one the inbox must add, because no owner row or
 * starter rule lists them (wait_up_person).
 */
export type WaitReach = { agentReachable: boolean; fallbackPerson: string | null; exclude?: ReadonlyArray<string> };
export type WaitAudience = { agent: AgentOwner | null; people: string[]; person: string | null };

export function waitAudience(f: SessionOwnerFacts, reach: WaitReach): WaitAudience {
  const agent = agentOwnerOf(f);
  if (agent && reach.agentReachable) return { agent, people: [], person: null };
  const out = new Set((reach.exclude ?? []).map(String));
  const ok = (id: unknown): id is string => id != null && id !== "" && !out.has(String(id));
  const o = ownersOf(f);
  const people = o.people.filter(ok);
  if (people.length) return { agent: null, people, person: null };
  if (ok(o.implicitStarter)) return { agent: null, people: [o.implicitStarter], person: null };
  const fallback = [!f.role_started ? f.starter : null, reach.fallbackPerson].find(ok) ?? null;
  return { agent: null, people: fallback ? [String(fallback)] : [], person: fallback ? String(fallback) : null };
}

export function ownsSession(f: SessionOwnerFacts, viewerId: string): boolean {
  const o = ownersOf(f);
  return o.people.includes(String(viewerId)) || o.implicitStarter === String(viewerId);
}

/** Who may change the owners: an owner, or the account that runs it. Anyone
 *  who can see the session may add themselves (ownersChangeRefusal). */
export function mayEditOwners(f: SessionOwnerFacts, viewerId: string): boolean {
  return ownsSession(f, viewerId) || str(f.user_id) === String(viewerId);
}

/** The change takes an agent owner off: the role goes, or the parent is released. */
export function removesAgentOwner(f: SessionOwnerFacts, change: OwnersChange): boolean {
  const o = ownersOf(f);
  return (change.role === null && !!o.role) || (!!change.releaseParent && !!o.parentSession);
}

/**
 * The facts after one change, in the order the server writes it: the role,
 * the parent's release, the implicit starter's own row (written first when
 * the change would otherwise leave them out), the people added, rows
 * restored, then the people removed. A take-over takes every agent owner
 * off and adds the actor unless the change removes them; removing the role
 * or releasing the parent alone adds nobody. `now` stamps new rows and the
 * release.
 */
export function applyOwnersChangeTo(f: SessionOwnerFacts, change: OwnersChange, ctx: { actor: string; now: number }): SessionOwnerFacts {
  const before = ownersOf(f);
  const actor = String(ctx.actor);
  const removed = new Set((change.remove ?? []).map(String));
  const takeOver = !!change.takeOver;
  const adopt = str(change.adoptParent);
  const detach = !adopt && !!change.detachParent;
  const role = takeOver || adopt ? null : change.role === undefined ? str(f.org_role_id) : str(change.role);
  const release = !adopt && (takeOver || !!change.releaseParent) && !!before.parentSession;
  const add = (change.add ?? []).map(String);
  if (takeOver && !removed.has(actor)) add.push(actor);

  let rows = sortedRows(f.rows);
  const starter = before.implicitStarter;
  if (starter && !removed.has(starter) && (add.length > 0 || !!change.restore?.length || !!role)) rows = [{ user_id: starter, added_at: ctx.now }];
  for (const id of add) if (!rows.some((r) => r.user_id === id)) rows = [...rows, { user_id: id, added_at: ctx.now }];
  for (const r of change.restore ?? []) if (!rows.some((x) => x.user_id === String(r.user_id))) rows = [...rows, { user_id: String(r.user_id), added_at: r.added_at }];
  const keepsActor = add.includes(actor) || (change.restore ?? []).some((r) => String(r.user_id) === actor);
  rows = sortedRows(rows.filter((r) => !removed.has(r.user_id) && !(adopt && r.user_id === actor && !keepsActor)));

  return {
    ...f,
    rows,
    org_role_id: role,
    ...(adopt ? { parent_conversation_id: adopt } : detach ? { parent_conversation_id: null } : {}),
    parent_released_at: adopt ? (change.releaseParent ? ctx.now : null) : detach ? null : release ? ctx.now : f.parent_released_at ?? null,
    role_started: takeOver || adopt ? null : f.role_started ?? null,
  };
}

/** A change only adds the actor: what anyone who can see the session may do. */
function addsOnlySelf(change: OwnersChange, actor: string): boolean {
  const add = (change.add ?? []).map(String);
  return add.length > 0 && add.every((id) => id === actor) && !change.remove?.length && !change.restore?.length
    && change.role === undefined && !change.releaseParent && !change.takeOver && !change.adoptParent && !change.detachParent;
}

/**
 * Why the actor may not make this change, or null when they may. Who the
 * people are (teammates, never agent accounts) is the server's to check; this
 * is the part a client can paint: the edit right, and that the session keeps
 * an owner and the actor really leaves when they remove themselves.
 */
export function ownersChangeRefusal(f: SessionOwnerFacts, change: OwnersChange, ctx: { actor: string; now: number }): string | null {
  const actor = String(ctx.actor);
  if (!mayEditOwners(f, actor) && !addsOnlySelf(change, actor)) return "Only its owners can change who owns it; you can add yourself";
  return ownersLeftRefusal(f, change, ctx);
}

/** The half of ownersChangeRefusal that holds for every door, whoever may
 *  edit: the session keeps an owner, and an owner who removes themselves leaves. */
export function ownersLeftRefusal(f: SessionOwnerFacts, change: OwnersChange, ctx: { actor: string; now: number }): string | null {
  const actor = String(ctx.actor);
  const adopt = adoptParentRefusal(f, change);
  if (adopt) return adopt;
  const after = ownersOf(applyOwnersChangeTo(f, change, ctx));
  if (!after.people.length && !after.role && !after.parentSession && !after.implicitStarter) return "Nobody would own it: add someone first";
  if ((change.remove ?? []).map(String).includes(actor) && after.implicitStarter === actor) {
    return "You started it and nobody else owns it: add someone before you leave";
  }
  return null;
}

/** Why the session cannot work for the session an adopt names, as far as its
 *  own facts tell: itself, or the parent that already owns it. Where the
 *  target sits (a cycle, killed, unreadable) is the server's to check. */
export function adoptParentRefusal(f: SessionOwnerFacts, change: OwnersChange): string | null {
  const target = str(change.adoptParent);
  if (!target) return null;
  if (target === str(f.conversation_id)) return "A session cannot work for itself";
  if (target === ownersOf(f).parentSession && !change.releaseParent) return "It already works for that session";
  return null;
}

/** The role itself acts through this session: its standing session, or a
 *  session the role started and still owns. What such a session starts is
 *  the role's start (role_started); what a person's session starts is not,
 *  even when that session has a role among its owners. */
export function actsForRole(row: { standing_role_id?: unknown; role_started?: boolean | null; org_role_id?: unknown }): boolean {
  return !!str(row.standing_role_id) || (!!row.role_started && !!str(row.org_role_id));
}
