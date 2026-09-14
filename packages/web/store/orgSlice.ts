// The org tree slice: the `orgTree` singleton (fed by hooks/useSyncOrgTree from
// org.tree) and the reshaping actions (docs/architecture/org-roles.md S6).
// Every action patches the snapshot optimistically so the graph moves in the
// same tick as the gesture, and rides `dispatch` to the matching orgRoles
// mutation (convex/dispatch.ts SIDE_EFFECTS, keyed by the action name). The
// snapshot is a meta singleton, not a dispatch table, so the middleware sends
// no generic patches for it and keeps no pending entry for it either.
//
// Pending protection therefore lives here. org.tree recomputes on any
// conversation write in the workspace, so a push that started before the
// mutation landed carries the OLD shape and would revert the gesture for one
// round trip. Each action records its edit as an INTENT (`orgIntents`), and
// the singleton's merge (ORG_SYNC_REGISTRY) replays every open intent onto
// each incoming tree. An intent is dropped the moment an incoming tree already
// agrees with it: the server's own recompute is the acknowledgement. The same
// apply function serves the draft and the merge, so there is one definition
// of what each edit does to a tree.
import { action, sync } from "./mutativeMiddleware";
import {
  countStates,
  sameParent,
  sortOrgSessions,
  ORG_TOP_N,
  type OrgParentRef,
  type OrgPerson,
  type OrgRole,
  type OrgScope,
  type OrgSession,
  type OrgTree,
} from "../components/org/orgTypes";
import { isConvexId } from "../lib/entityLinks";

/** An optimistic edit awaiting the server's echo (see the header). */
export type OrgIntent =
  | { kind: "moveSession"; id: string; conversation_id: string; target: OrgParentRef; at: number }
  | { kind: "moveRole"; id: string; role_id: string; reports_to: OrgParentRef; at: number }
  | { kind: "follow"; id: string; role_short_id: string; channel_id: string; follow: boolean; at: number };

/** An intent older than this is abandoned: the dispatch failed or was
 *  rejected and no echo will ever agree with it. */
export const ORG_INTENT_TTL_MS = 60_000;

export type OrgSliceData = {
  orgTree: OrgTree | null;
  /** Open optimistic edits, replayed onto every incoming org.tree push. */
  orgIntents: OrgIntent[];
};

export type OrgCreateRoleInput = {
  name: string;
  handle: string;
  team_id?: string;
  scope?: OrgScope;
  reports_to?: OrgParentRef;
  charter?: string;
  /** The hire form (org-init.md O3): provision the standing session in the
   *  same gesture, in this cwd, and start with these caps. */
  provision?: boolean;
  project_path?: string;
  caps?: OrgRole["caps"];
  /** The caller, for the optimistic row (host and default reports_to). */
  host_user_id: string;
  /** Stub id: the row is re-keyed when org.tree echoes the real one. */
  client_id: string;
};

export type OrgUpdateRoleInput = {
  name?: string;
  handle?: string;
  scope?: OrgScope;
  charter?: string;
  status?: OrgRole["status"];
  // Standing agent settings (org-roles-standing.md T4); dispatch routes them
  // to orgRoles.setTrust / setCaps.
  trust?: OrgRole["trust"];
  caps?: OrgRole["caps"];
};

export type OrgSliceActions = {
  /** Move a session under a person (ownership) or a role (org_role_id). */
  reparentOrgSession: (conversationId: string, target: OrgParentRef) => void;
  /** Change a role's reports_to. */
  reparentOrgRole: (roleId: string, reportsTo: OrgParentRef) => void;
  createOrgRole: (input: OrgCreateRoleInput) => void;
  updateOrgRole: (roleId: string, fields: OrgUpdateRoleInput) => void;
  /** Retire a role: its sessions fall back to their owners. */
  retireOrgRole: (roleId: string) => void;
  /** Add or drop a chat channel from a role's follow list (agent-channels
   *  C1). Keyed by the role's short id, which is what orgChannels resolves. */
  followOrgChannel: (roleShortId: string, channelId: string, follow: boolean) => void;
  /** Drop an intent the dispatch rail rejected, so the tree stops replaying it. */
  dropOrgIntent: (intentId: string) => void;
};

export type OrgSliceState = OrgSliceData & OrgSliceActions;

type OrgDraft = OrgSliceData;

/** Every holder of a `sessions` list in the tree, keyed by parent ref. */
function parentBucket(tree: OrgTree, ref: OrgParentRef): OrgPerson | OrgRole | undefined {
  return ref.kind === "user"
    ? tree.people.find((p) => p.user_id === ref.user_id)
    : tree.roles.find((r) => r._id === ref.role_id);
}

function refill(bucket: OrgPerson | OrgRole) {
  bucket.sessions = sortOrgSessions(bucket.sessions).slice(0, ORG_TOP_N);
}

/** Find the session in whichever bucket holds it and pull it out. */
function detachSession(tree: OrgTree, conversationId: string): { session: OrgSession; from: OrgPerson | OrgRole } | null {
  const buckets: (OrgPerson | OrgRole)[] = [...tree.people, ...tree.roles];
  for (const b of buckets) {
    const i = b.sessions.findIndex((s) => s._id === conversationId);
    if (i < 0) continue;
    const [session] = b.sessions.splice(i, 1);
    b.total = Math.max(0, b.total - 1);
    b.counts[session.state] = Math.max(0, (b.counts[session.state] ?? 0) - 1);
    return { session, from: b };
  }
  return null;
}

function attachSession(bucket: OrgPerson | OrgRole, session: OrgSession) {
  bucket.sessions.push(session);
  bucket.total += 1;
  bucket.counts[session.state] = (bucket.counts[session.state] ?? 0) + 1;
  refill(bucket);
}

/** Where the tree files a session, or null when it is beyond every top N. */
export function orgSessionParent(tree: OrgTree, conversationId: string): OrgParentRef | null {
  for (const p of tree.people) if (p.sessions.some((s) => s._id === conversationId)) return { kind: "user", user_id: p.user_id };
  for (const r of tree.roles) if (r.sessions.some((s) => s._id === conversationId)) return { kind: "role", role_id: r._id };
  return null;
}

// ---------------------------------------------------------------- intents

/** Does `tree` already show this edit? Then the server has echoed it. */
export function orgIntentSatisfied(tree: OrgTree, intent: OrgIntent): boolean {
  switch (intent.kind) {
    case "moveSession": {
      const parent = orgSessionParent(tree, intent.conversation_id);
      // A session beyond the target's top N cannot be seen in the snapshot at
      // all; the echo is then indistinguishable from the old shape, so the
      // intent stays until its TTL. Visible under the target = confirmed.
      return !!parent && sameParent(parent, intent.target);
    }
    case "moveRole": {
      const role = tree.roles.find((r) => r._id === intent.role_id);
      return !role || sameParent(role.reports_to, intent.reports_to);
    }
    case "follow": {
      const role = tree.roles.find((r) => r.short_id === intent.role_short_id);
      if (!role) return true;
      return (role.follow_channel_ids ?? []).includes(intent.channel_id) === intent.follow;
    }
  }
}

/**
 * Apply one edit to a tree in place. Used by the actions on the draft and by
 * the merge on each incoming push, so the optimistic shape and the replayed
 * shape are the same shape. `row` carries the session for a move whose
 * subject is not among the tree's top N (loaded through org.sessionsUnder).
 */
export function applyOrgIntent(tree: OrgTree, intent: OrgIntent, row?: OrgSession | null): void {
  switch (intent.kind) {
    case "moveSession": {
      const to = parentBucket(tree, intent.target);
      if (!to) return;
      const moved = detachSession(tree, intent.conversation_id);
      let session = moved?.session ?? (row ? { ...row } : null);
      if (!moved && row) {
        // Beyond the source's top N: the row is not in the snapshot, but the
        // source's total and counts still include it.
        const from = orgSessionParent(tree, row._id) ?? (row.org_role_id ? { kind: "role" as const, role_id: row.org_role_id } : row.owner_user_id ? { kind: "user" as const, user_id: row.owner_user_id } : null);
        const fromBucket = from && !sameParent(from, intent.target) ? parentBucket(tree, from) : undefined;
        if (fromBucket) {
          fromBucket.total = Math.max(0, fromBucket.total - 1);
          fromBucket.counts[row.state] = Math.max(0, (fromBucket.counts[row.state] ?? 0) - 1);
        }
      }
      if (!session) return;
      if (intent.target.kind === "user") {
        session.owner_user_id = intent.target.user_id;
        delete session.org_role_id;
      } else {
        session.org_role_id = intent.target.role_id;
      }
      session.updated_at = Math.max(session.updated_at, intent.at);
      attachSession(to, session);
      return;
    }
    case "moveRole": {
      const role = tree.roles.find((r) => r._id === intent.role_id);
      if (!role || sameParent(role.reports_to, intent.reports_to)) return;
      if (orgRoleReparentMakesCycle(tree, intent.role_id, intent.reports_to)) return;
      role.reports_to = intent.reports_to;
      role.updated_at = Math.max(role.updated_at, intent.at);
      return;
    }
    case "follow": {
      const role = tree.roles.find((r) => r.short_id === intent.role_short_id);
      if (!role) return;
      const cur = role.follow_channel_ids ?? [];
      if (cur.includes(intent.channel_id) === intent.follow) return;
      role.follow_channel_ids = intent.follow ? [...cur, intent.channel_id] : cur.filter((id) => id !== intent.channel_id);
      role.updated_at = Math.max(role.updated_at, intent.at);
      return;
    }
  }
}

/**
 * The singleton merge: take the server's tree, drop every intent it already
 * agrees with (or that aged out), replay the rest. Returns the open intents
 * alongside the merged tree so the store can update both slots.
 */
export function mergeOrgTree(incoming: OrgTree, intents: OrgIntent[], now = Date.now()): { tree: OrgTree; intents: OrgIntent[] } {
  const open = intents.filter((i) => now - i.at < ORG_INTENT_TTL_MS && !orgIntentSatisfied(incoming, i));
  if (open.length === 0) return { tree: incoming, intents: open };
  // Structured clone: the incoming payload is the feeder's object and must not
  // be mutated in place (a coalesced push may reuse it).
  const tree: OrgTree = JSON.parse(JSON.stringify(incoming));
  for (const i of open) applyOrgIntent(tree, i);
  return { tree, intents: open };
}

/**
 * The dispatch rail refused an org action (useEnsureDispatch's error handler):
 * drop the intent for that subject so the tree stops showing the edit. Args
 * are the action's own arguments, so the subject is read from them.
 */
export function dropRejectedOrgIntent(state: { orgIntents: OrgIntent[]; dropOrgIntent: (id: string) => void }, action: string, args: unknown): void {
  if (!Array.isArray(args)) return;
  const hit = state.orgIntents.find((i) =>
    (action === "reparentOrgSession" && i.kind === "moveSession" && i.conversation_id === args[0]) ||
    (action === "reparentOrgRole" && i.kind === "moveRole" && i.role_id === args[0]) ||
    (action === "followOrgChannel" && i.kind === "follow" && i.role_short_id === args[0] && i.channel_id === args[1]));
  if (hit) state.dropOrgIntent(hit.id);
}

let intentSeq = 0;
function intentId(): string {
  intentSeq += 1;
  return `oi-${Date.now().toString(36)}-${intentSeq}`;
}

/** Record an intent, replacing an earlier one on the same subject. */
function pushIntent(draft: OrgDraft, intent: OrgIntent): void {
  const subjectOf = (i: OrgIntent) => i.kind === "moveSession" ? `s:${i.conversation_id}` : i.kind === "moveRole" ? `r:${i.role_id}` : `f:${i.role_short_id}:${i.channel_id}`;
  const key = subjectOf(intent);
  draft.orgIntents = [...draft.orgIntents.filter((i) => subjectOf(i) !== key), intent];
}

/** Would making `role` report to `target` close a loop? Walk up from the target. */
export function orgRoleReparentMakesCycle(tree: OrgTree, roleId: string, target: OrgParentRef): boolean {
  let cur: OrgParentRef | undefined = target;
  for (let depth = 0; cur && depth < 32; depth++) {
    if (cur.kind === "user") return false;
    if (cur.role_id === roleId) return true;
    cur = tree.roles.find((r) => r._id === (cur as any).role_id)?.reports_to;
  }
  return false;
}

export const ORG_SYNC_REGISTRY = {
  // The server stamps generated_at on every execution; strip it so an
  // unchanged tree doesn't wake subscribers on every no-op push. The merge
  // replays open intents (see the header) and, as a side effect of running
  // inside the draft, prunes the ones the push confirmed. A `merge` bypasses
  // the singleton's equality bail, so it hands back the incoming object
  // itself when nothing is open: the store's identity check then still sees
  // a no-op push as a no-op.
  orgTree: {
    kind: "singleton" as const,
    normalize: (v: any, draft: any) => {
      if (!v || typeof v !== "object") return v;
      const { generated_at: _g, ...rest } = v;
      const intents: OrgIntent[] = draft?.orgIntents ?? [];
      if (intents.length === 0) return rest;
      const merged = mergeOrgTree(rest as OrgTree, intents);
      if (draft && merged.intents.length !== intents.length) draft.orgIntents = merged.intents;
      return merged.tree;
    },
  },
};

export function createOrgSlice(): OrgSliceState {
  return {
    orgTree: null,

    orgIntents: [],

    // `row` is the session when the page holds it outside the tree's top N
    // (loaded through org.sessionsUnder); the slice cannot find it otherwise.
    reparentOrgSession: action(function (this: OrgDraft, conversationId: string, target: OrgParentRef, row?: OrgSession | null) {
      const tree = this.orgTree;
      if (!tree || !parentBucket(tree, target)) return;
      // Nothing to move: the row is in no bucket and the page did not hand it
      // over. Recording an intent would replay a no-op until its TTL.
      if (!row && !orgSessionParent(tree, conversationId)) return;
      const intent: OrgIntent = { kind: "moveSession", id: intentId(), conversation_id: conversationId, target, at: Date.now() };
      applyOrgIntent(tree, intent, row);
      pushIntent(this, intent);
    }),

    reparentOrgRole: action(function (this: OrgDraft, roleId: string, reportsTo: OrgParentRef) {
      const tree = this.orgTree;
      if (!tree) return;
      const role = tree.roles.find((r) => r._id === roleId);
      if (!role || sameParent(role.reports_to, reportsTo)) return;
      if (orgRoleReparentMakesCycle(tree, roleId, reportsTo)) return;
      const intent: OrgIntent = { kind: "moveRole", id: intentId(), role_id: roleId, reports_to: reportsTo, at: Date.now() };
      applyOrgIntent(tree, intent);
      pushIntent(this, intent);
    }),

    createOrgRole: action(function (this: OrgDraft, input: OrgCreateRoleInput) {
      const tree = this.orgTree;
      if (!tree) return;
      const now = Date.now();
      const team = tree.workspace.kind === "team";
      tree.roles.push({
        _id: input.client_id,
        short_id: "or-…",
        scope_type: team ? "team" : "user",
        ...(team ? { team_id: tree.workspace.id } : { scope_user_id: input.host_user_id }),
        host_user_id: input.host_user_id,
        name: input.name,
        handle: input.handle,
        scope: input.scope ?? { project_ids: [], plan_ids: [] },
        reports_to: input.reports_to ?? { kind: "user", user_id: input.host_user_id },
        status: "active",
        ...(input.charter ? { charter: input.charter } : {}),
        ...(input.caps ? { caps: { ...input.caps } } : {}),
        trust: "understand",
        created_by: input.host_user_id,
        created_at: now,
        updated_at: now,
        counts: countStates([]),
        sessions: [],
        total: 0,
        scope_names: { projects: [], plans: [] },
      });
    }),

    updateOrgRole: action(function (this: OrgDraft, roleId: string, fields: OrgUpdateRoleInput) {
      const role = this.orgTree?.roles.find((r) => r._id === roleId);
      if (!role) return;
      if (fields.name !== undefined) role.name = fields.name;
      if (fields.handle !== undefined) role.handle = fields.handle;
      if (fields.charter !== undefined) role.charter = fields.charter;
      if (fields.status !== undefined) role.status = fields.status;
      if (fields.trust !== undefined) role.trust = fields.trust;
      if (fields.caps !== undefined) role.caps = fields.caps;
      if (fields.scope !== undefined) {
        role.scope = { project_ids: [...fields.scope.project_ids], plan_ids: [...fields.scope.plan_ids] };
        // Names for ids we already knew stay; new ones resolve on the next
        // org.tree push (the panel reads titles from the store meanwhile).
        role.scope_names = {
          projects: role.scope_names.projects.filter((p) => role.scope.project_ids.includes(p.id)),
          plans: role.scope_names.plans.filter((p) => role.scope.plan_ids.includes(p.id)),
        };
      }
      role.updated_at = Date.now();
    }),

    followOrgChannel: action(function (this: OrgDraft, roleShortId: string, channelId: string, follow: boolean) {
      const tree = this.orgTree;
      const role = tree?.roles.find((r) => r.short_id === roleShortId);
      if (!tree || !role) return;
      // A channel still keyed by a client stub cannot be followed server side
      // (the dispatch side effect drops it); do not show a follow that will
      // never land. The caller re-tries once the room has its real id.
      if (!isConvexId(channelId)) return;
      if ((role.follow_channel_ids ?? []).includes(channelId) === follow) return;
      const intent: OrgIntent = { kind: "follow", id: intentId(), role_short_id: roleShortId, channel_id: channelId, follow, at: Date.now() };
      applyOrgIntent(tree, intent);
      pushIntent(this, intent);
    }),

    dropOrgIntent: sync(function (this: OrgDraft, intentId: string) {
      this.orgIntents = this.orgIntents.filter((i) => i.id !== intentId);
    }),

    retireOrgRole: action(function (this: OrgDraft, roleId: string) {
      const tree = this.orgTree;
      if (!tree) return;
      const i = tree.roles.findIndex((r) => r._id === roleId);
      if (i < 0) return;
      const [role] = tree.roles.splice(i, 1);
      // Its sessions fall back to their owners; roles under it fall back to
      // whatever it reported to (the server does the same walk).
      let rehomed = 0;
      for (const s of role.sessions) {
        delete s.org_role_id;
        const owner = s.owner_user_id ? parentBucket(tree, { kind: "user", user_id: s.owner_user_id }) : undefined;
        if (owner) { attachSession(owner, s); rehomed += 1; }
      }
      // The snapshot carries only the role's top N; the rest still count. Put
      // the remainder on the role's parent when that is a person (the likely
      // owner) so the header total and the card tallies do not dip for one
      // round trip. The echo is authoritative and corrects any misfile.
      const remainder = Math.max(0, role.total - rehomed);
      const fallback = role.reports_to.kind === "user" ? parentBucket(tree, role.reports_to) : undefined;
      if (remainder > 0 && fallback) {
        fallback.total += remainder;
        for (const k of Object.keys(role.counts) as (keyof typeof role.counts)[]) {
          const seen = role.sessions.filter((s) => s.state === k).length;
          fallback.counts[k] = (fallback.counts[k] ?? 0) + Math.max(0, (role.counts[k] ?? 0) - seen);
        }
      }
      for (const r of tree.roles) {
        if (r.reports_to.kind === "role" && r.reports_to.role_id === roleId) r.reports_to = role.reports_to;
      }
    }),
  };
}
