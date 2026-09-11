// The org tree slice: the `orgTree` singleton (fed by hooks/useSyncOrgTree from
// org.tree) and the five reshaping actions (docs/architecture/org-roles.md S6).
// Every action patches the snapshot optimistically so the graph moves in the
// same tick as the gesture, and rides `dispatch` to the matching orgRoles
// mutation (convex/dispatch.ts SIDE_EFFECTS, keyed by the action name). The
// snapshot is a meta singleton, not a dispatch table, so the middleware sends
// no generic patches for it: the side effect is the only server write, and the
// next org.tree push replaces the optimistic shape with the server's.
import { action } from "./mutativeMiddleware";
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

export type OrgSliceData = {
  orgTree: OrgTree | null;
};

export type OrgCreateRoleInput = {
  name: string;
  handle: string;
  team_id?: string;
  scope?: OrgScope;
  reports_to?: OrgParentRef;
  charter?: string;
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
    b.counts[session.work_state] = Math.max(0, (b.counts[session.work_state] ?? 0) - 1);
    return { session, from: b };
  }
  return null;
}

function attachSession(bucket: OrgPerson | OrgRole, session: OrgSession) {
  bucket.sessions.push(session);
  bucket.total += 1;
  bucket.counts[session.work_state] = (bucket.counts[session.work_state] ?? 0) + 1;
  refill(bucket);
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
  // unchanged tree doesn't wake subscribers on every no-op push.
  orgTree: {
    kind: "singleton" as const,
    normalize: (v: any) => {
      if (!v || typeof v !== "object") return v;
      const { generated_at: _g, ...rest } = v;
      return rest;
    },
  },
};

export function createOrgSlice(): OrgSliceState {
  return {
    orgTree: null,

    reparentOrgSession: action(function (this: OrgDraft, conversationId: string, target: OrgParentRef) {
      const tree = this.orgTree;
      if (!tree) return;
      const to = parentBucket(tree, target);
      if (!to) return;
      const moved = detachSession(tree, conversationId);
      if (!moved) return;
      const { session } = moved;
      if (target.kind === "user") {
        session.owner_user_id = target.user_id;
        delete session.org_role_id;
      } else {
        session.org_role_id = target.role_id;
      }
      session.updated_at = Date.now();
      attachSession(to, session);
    }),

    reparentOrgRole: action(function (this: OrgDraft, roleId: string, reportsTo: OrgParentRef) {
      const tree = this.orgTree;
      if (!tree) return;
      const role = tree.roles.find((r) => r._id === roleId);
      if (!role || sameParent(role.reports_to, reportsTo)) return;
      if (orgRoleReparentMakesCycle(tree, roleId, reportsTo)) return;
      role.reports_to = reportsTo;
      role.updated_at = Date.now();
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

    retireOrgRole: action(function (this: OrgDraft, roleId: string) {
      const tree = this.orgTree;
      if (!tree) return;
      const i = tree.roles.findIndex((r) => r._id === roleId);
      if (i < 0) return;
      const [role] = tree.roles.splice(i, 1);
      // Its sessions fall back to their owners; roles under it fall back to
      // whatever it reported to (the server does the same walk).
      for (const s of role.sessions) {
        delete s.org_role_id;
        const owner = s.owner_user_id ? parentBucket(tree, { kind: "user", user_id: s.owner_user_id }) : undefined;
        if (owner) attachSession(owner, s);
      }
      for (const r of tree.roles) {
        if (r.reports_to.kind === "role" && r.reports_to.role_id === roleId) r.reports_to = role.reports_to;
      }
    }),
  };
}
