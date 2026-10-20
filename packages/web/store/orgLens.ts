// The inbox's org lenses, split out of inboxStore. Pure grouping over the
// store's rows; inboxStore re-exports every name here.
import type { InboxSession, InboxViewMode, PlanItem, ProjectItem, TaskItem } from "./inboxStore";
import { byPinThenActivity, groupSessionsBy, resolveInboxViewMode } from "./inboxStore";
import { makeCollectionSig } from "./wakeSig";

// The org lenses: "By project", "By goal" and "By reports" regroup the same
// active set the label and plan lenses do, on the same skeleton
// (groupSessionsBy), keyed on what the session's work is filed under. Unbound
// sessions fall to the repo-folder tier exactly as in the other lenses.
export type OrgLensMode = "project" | "goal" | "reports";
export const ORG_LENS_MODES: readonly OrgLensMode[] = ["project", "goal", "reports"];
export function isOrgLensMode(mode: InboxViewMode): mode is OrgLensMode {
  return (ORG_LENS_MODES as readonly string[]).includes(mode);
}

type LensRole = {
  _id: string;
  name: string;
  status: string;
  reports_to: { kind: "user"; user_id: string } | { kind: "role"; role_id: string };
  standing?: { conversation_id?: string } | null;
};
type LensPerson = { user_id: string; name: string; image?: string; reports_to_user_id?: string };
export type OrgLensSources = {
  tasks: Record<string, Pick<TaskItem, "project_id">>;
  plans: Record<string, Pick<PlanItem, "project_id">>;
  projects: Record<string, Pick<ProjectItem, "_id" | "title">>;
  initiatives: Record<string, { _id: string; title: string; status: string; priority?: string; project_ids: string[]; parent_initiative_id?: string }>;
  roles: readonly LensRole[];
  /** The workspace's people and who each reports to (orgTree.people). */
  people: readonly LensPerson[];
  meId: string | null;
  // Every cached row, for a report's standing session: an anchor lives in its
  // own space and is rarely in the active set, but its report always leads
  // with it.
  sessions: Record<string, InboxSession>;
};
export type OrgLensGroup = { key: string; label: string; items: InboxSession[]; roleId?: string; userId?: string; image?: string };

export type OrgLensState = {
  tasks: OrgLensSources["tasks"];
  plans: OrgLensSources["plans"];
  projects: OrgLensSources["projects"];
  initiatives: OrgLensSources["initiatives"];
  orgTree: { roles: readonly LensRole[]; people?: readonly LensPerson[] } | null;
  currentUser?: any;
  sessions: Record<string, InboxSession>;
};
export function orgLensSourcesOf(state: Partial<OrgLensState> & { sessions: Record<string, InboxSession> }): OrgLensSources {
  return {
    tasks: state.tasks ?? {}, plans: state.plans ?? {}, projects: state.projects ?? {}, initiatives: state.initiatives ?? {},
    roles: state.orgTree?.roles ?? [],
    people: state.orgTree?.people ?? [],
    meId: state.currentUser?._id?.toString?.() ?? null,
    sessions: state.sessions,
  };
}

// The real Project a session's work is filed under: its task's, else its
// plan's. Only a project the store holds counts, so every group has a name.
export function sessionProjectId(s: InboxSession, src: Pick<OrgLensSources, "tasks" | "plans" | "projects">): string | null {
  const id = (s.active_task && src.tasks[s.active_task._id]?.project_id) || (s.active_plan && src.plans[s.active_plan._id]?.project_id) || null;
  return id && src.projects[id] ? id : null;
}

const OPEN_GOAL = new Set(["proposed", "planned", "active"]);
const GOAL_PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

// project id → the top-level goal it serves. A project under a sub-goal rolls
// up to that sub-goal's parent: the lens shows the few goals a person steers.
// A project in several goals files under the highest-priority one.
function goalOfProjectMap(initiatives: OrgLensSources["initiatives"]): Map<string, string> {
  const topOf = (g: OrgLensSources["initiatives"][string]) => {
    const parent = g.parent_initiative_id ? initiatives[g.parent_initiative_id] : undefined;
    return parent && OPEN_GOAL.has(parent.status) ? parent : g;
  };
  const rank = (g: { priority?: string }) => GOAL_PRIORITY_RANK[g.priority ?? ""] ?? 9;
  const out = new Map<string, string>();
  for (const g of Object.values(initiatives)) {
    if (!OPEN_GOAL.has(g.status)) continue;
    const top = topOf(g);
    for (const pid of g.project_ids) {
      const cur = out.get(pid);
      if (!cur || rank(top) < rank(initiatives[cur])) out.set(pid, top._id);
    }
  }
  return out;
}

// A report group's key: a role's id, or `person:<user id>` for a person.
const personReportKey = (userId: string) => `person:${userId}`;

// The viewer's direct report a role or a person sits under, as a group key: a
// role that reports to the viewer is its own report; a role under a person,
// and a person under a person, fold into the person who reports to the
// viewer. Null for anything outside the viewer's line.
function reportRootResolver(src: Pick<OrgLensSources, "roles" | "people" | "meId">): { ofRole: (roleId: string | null | undefined) => string | null; ofPerson: (userId: string | null | undefined) => string | null } {
  const { meId } = src;
  const byId = new Map(src.roles.map((r) => [String(r._id), r]));
  const managerOf = new Map(src.people.map((p) => [String(p.user_id), p.reports_to_user_id ? String(p.reports_to_user_id) : undefined]));
  const personMemo = new Map<string, string | null>();
  const ofPerson = (userId: string | null | undefined): string | null => {
    if (!userId || !meId) return null;
    const start = String(userId);
    if (personMemo.has(start)) return personMemo.get(start)!;
    let root: string | null = null;
    let cur: string | undefined = start;
    for (let depth = 0; cur && cur !== meId && depth < 64; depth++) {
      const up = managerOf.get(cur);
      if (up === meId) { root = personReportKey(cur); break; }
      cur = up;
    }
    personMemo.set(start, root);
    return root;
  };
  const roleMemo = new Map<string, string | null>();
  const ofRole = (roleId: string | null | undefined): string | null => {
    if (!roleId || !meId) return null;
    const start = String(roleId);
    if (roleMemo.has(start)) return roleMemo.get(start)!;
    let cur = byId.get(start);
    let root: string | null = null;
    for (let depth = 0; cur && depth < 32; depth++) {
      if (cur.reports_to.kind === "user") {
        const to = cur.reports_to.user_id;
        root = to === meId ? (cur.status !== "retired" ? String(cur._id) : null) : ofPerson(to);
        break;
      }
      cur = byId.get(cur.reports_to.role_id);
    }
    roleMemo.set(start, root);
    return root;
  };
  return { ofRole, ofPerson };
}

const bySizeThenLabel = (a: OrgLensGroup, b: OrgLensGroup) => b.items.length - a.items.length || a.label.localeCompare(b.label);

export function groupSessionsForOrgLens(
  mode: OrgLensMode,
  items: InboxSession[],
  src: OrgLensSources,
): { groups: OrgLensGroup[]; projectGroups: Array<{ name: string; items: InboxSession[] }> } {
  if (mode === "reports") {
    const { ofRole, ofPerson } = reportRootResolver(src);
    const { primaryGroups, projectGroups } = groupSessionsBy(
      items,
      // A session filed under a role goes where the role goes; any other goes
      // with the person it belongs to. The items are what the inbox already
      // shows, so a report's group never holds a session the viewer could not see.
      (sess) => {
        const roleId = sess.standing_role_id ?? sess.org_role_id;
        return roleId ? ofRole(roleId) : ofPerson(sess.owner_user_id ?? sess.user_id);
      },
      // Reports in the org's own order, roles then people; a role leads with
      // its standing session, fetched from the cache when the inbox has it set aside.
      (byKey) => [
        ...src.roles.flatMap((role) => {
          const roleId = String(role._id);
          if (ofRole(roleId) !== roleId) return [];
          const leadId = role.standing?.conversation_id;
          const rest = (byKey.get(roleId) ?? []).filter((x) => x._id !== leadId).sort(byPinThenActivity);
          const lead = (leadId && byKey.get(roleId)?.find((x) => x._id === leadId)) || (leadId ? src.sessions[leadId] : undefined);
          const leadRow = lead && !lead.is_pinned && !lead.inbox_killed_at ? [lead] : [];
          const list = [...leadRow, ...rest];
          return list.length ? [{ key: roleId, label: role.name, items: list, roleId }] : [];
        }),
        ...src.people.flatMap((p): OrgLensGroup[] => {
          const key = personReportKey(String(p.user_id));
          const list = p.reports_to_user_id === src.meId ? byKey.get(key) : undefined;
          return list?.length ? [{ key, label: p.name, items: list.sort(byPinThenActivity), userId: String(p.user_id), image: p.image }] : [];
        }),
      ],
    );
    return { groups: primaryGroups, projectGroups };
  }
  const goalOf = mode === "goal" ? goalOfProjectMap(src.initiatives) : null;
  const { primaryGroups, projectGroups } = groupSessionsBy(
    items,
    (sess) => {
      const pid = sessionProjectId(sess, src);
      if (!pid) return null;
      const gid = goalOf?.get(pid);
      return gid ? `goal:${gid}` : `project:${pid}`;
    },
    (byKey) => {
      const groups = Array.from(byKey.entries()).map(([key, list]): OrgLensGroup => {
        const [kind, id] = key.split(":");
        const label = kind === "goal" ? src.initiatives[id].title : src.projects[id].title;
        return { key, label, items: list.sort(byPinThenActivity) };
      });
      // Goals lead (highest priority first), then projects that serve none.
      const rankOf = (g: OrgLensGroup) => g.key.startsWith("goal:") ? GOAL_PRIORITY_RANK[src.initiatives[g.key.slice(5)].priority ?? ""] ?? 9 : 10;
      return groups.sort((a, b) => rankOf(a) - rankOf(b) || bySizeThenLabel(a, b));
    },
  );
  return { groups: primaryGroups, projectGroups };
}

// What the org lenses read, as a wake signature: the panel re-renders when a
// fact a lens groups by changes, never on the rest of a task's churn. The
// task and goal collections only count while a lens is up; the roles always
// do (the menu offers "By reports" off them).
const lensTaskSig = makeCollectionSig((t: { project_id?: string }) => t.project_id ?? "");
const lensProjectSig = makeCollectionSig((p: { title?: string }) => p.title ?? "");
const lensGoalSig = makeCollectionSig((g: OrgLensSources["initiatives"][string]) =>
  `${g.title}|${g.status}|${g.priority ?? ""}|${g.parent_initiative_id ?? ""}|${g.project_ids.join(",")}`);
const lensRoleSigs = new WeakMap<object, string>();
function lensRoleSig(roles: readonly LensRole[]): string {
  let sig = lensRoleSigs.get(roles);
  if (sig === undefined) {
    sig = roles.map((r) => `${r._id}|${r.name}|${r.status}|${r.reports_to.kind === "user" ? r.reports_to.user_id : r.reports_to.role_id}|${r.standing?.conversation_id ?? ""}`).join("\n");
    lensRoleSigs.set(roles, sig);
  }
  return sig;
}
// The people's names, faces and who each reports to: never their presence or session counts.
const lensPeopleSigs = new WeakMap<object, string>();
function lensPeopleSig(people: readonly LensPerson[]): string {
  let sig = lensPeopleSigs.get(people);
  if (sig === undefined) {
    sig = people.map((p) => `${p.user_id}|${p.name}|${p.image ?? ""}|${p.reports_to_user_id ?? ""}`).join("\n");
    lensPeopleSigs.set(people, sig);
  }
  return sig;
}
export function orgLensWakeSig(state: OrgLensState & { clientState: { ui?: { inbox_view_mode?: InboxViewMode; inbox_flat_view?: boolean } } }): string {
  const roles = lensRoleSig(state.orgTree?.roles ?? []) + "\u0002" + lensPeopleSig(state.orgTree?.people ?? []);
  if (!isOrgLensMode(resolveInboxViewMode(state.clientState.ui))) return roles;
  return [roles, lensTaskSig(state.tasks), lensTaskSig(state.plans), lensProjectSig(state.projects), lensGoalSig(state.initiatives)].join("\u0001");
}

// Whether a lens has anything to group by, so the menu and the cycle offer
// only lenses that would change the list.
export function orgLensAvailable(mode: OrgLensMode, items: InboxSession[], src: OrgLensSources): boolean {
  if (mode === "reports") {
    return !!src.meId && (src.roles.some((r) => r.status !== "retired" && r.reports_to.kind === "user" && r.reports_to.user_id === src.meId)
      || src.people.some((p) => p.reports_to_user_id === src.meId));
  }
  if (mode === "goal") {
    const goals = goalOfProjectMap(src.initiatives);
    return items.some((x) => { const pid = sessionProjectId(x, src); return !!pid && goals.has(pid); });
  }
  return items.some((x) => !!sessionProjectId(x, src));
}
