// Open proposal changes resolved into the ghost plan the org layout draws
// (orgLayout.ts, docs/architecture/org-staffing.md S5), and the ref matching
// proposals and scope editors share.
import type { OrgPerson, OrgRole, OrgSession, OrgTree, OrgParentRef } from "./orgTypes";
import type { OrgChange, OrgProposalChange } from "./orgStaffingTypes";
import { editedOrgChange, isOrgQuietChange } from "@codecast/shared/contracts/orgProposal";
import { changeLine, chipLine } from "./orgMeta";
import { personNodeId, roleNodeId, sessionNodeId, type OrgGhostChip, type OrgGhostMeta, type OrgGhostPlan } from "./orgLayout";

export type OrgGhostOptions = {
  /** The session the viewer is looking from (id or short id): an adopt
   *  change offering it reads "this session". */
  viewerSession?: { id?: string | null; short_id?: string | null } | null;
  /** The workspace's projects and plans as the store holds them, so a ghost
   *  role's scope chips name the project the way the real card does. A
   *  proposal writes a scope as ids, short ids or titles. */
  projects?: readonly { id: string; title: string; short_id?: string }[];
  plans?: readonly { id: string; title: string; short_id?: string }[];
};

/** A Convex document id: what a proposal's scope carries when the analyzer
 *  wrote ids. Never shown to a person. */
const isInternalId = (ref: string) => /^[a-z0-9]{32}$/.test(ref.trim());

/** The scope names a ghost role draws (org-staffing.md S5), resolved against
 *  every row in hand: the store's projects and plans, then what the live
 *  roles' scope names carry. An unresolved short id or title is shown as
 *  written; an unresolved internal id is never shown, it reads as a project
 *  or plan not loaded yet. */
/** A change with every project and plan ref it carries named the way the
 *  chart names them (ghostScopeNames): the chip and the line a ghost draws
 *  say "pl-619 under Agent Quality", never the project's internal id. Kinds
 *  that carry no ref come back as they are. */
export function withScopeNames(change: OrgChange, tree: OrgTree, opts: OrgGhostOptions): OrgChange {
  const nameOf = (ref: string, kind: "projects" | "plans") => {
    const row = ghostScopeNames(kind === "projects" ? { projects: [ref] } : { plans: [ref] }, tree, opts)[kind][0];
    return kind === "plans" ? (row.short_id ?? row.title) : row.title;
  };
  const project = (ref: string) => nameOf(ref, "projects");
  const plan = (ref: string) => nameOf(ref, "plans");
  const either = (ref: string) => (/^pl-\d+$/i.test(ref) ? plan(ref) : project(ref));
  switch (change.kind) {
    case "file": return { ...change, plan: plan(change.plan), project: project(change.project) };
    case "project_meta": return { ...change, project: project(change.project) };
    case "scope": return { ...change, ...(change.add ? { add: change.add.map(either) } : {}), ...(change.remove ? { remove: change.remove.map(either) } : {}) };
    case "move": return { ...change, ...(change.scope_add ? { scope_add: change.scope_add.map(either) } : {}), ...(change.scope_remove ? { scope_remove: change.scope_remove.map(either) } : {}) };
    default: return change;
  }
}

export function ghostScopeNames(scope: { projects?: readonly string[]; plans?: readonly string[] } | undefined, tree: OrgTree, opts: OrgGhostOptions): OrgRole["scope_names"] {
  const known = <T extends { id: string; title: string; short_id?: string }>(rows: readonly T[] | undefined, fromRoles: (r: OrgRole) => readonly T[]) => [
    ...(rows ?? []),
    ...tree.roles.flatMap(fromRoles),
  ];
  const projects = known(opts.projects, (r) => r.scope_names.projects);
  const plans = known(opts.plans, (r) => r.scope_names.plans);
  const name = (ref: string, rows: readonly { id: string; title: string; short_id?: string }[], word: "project" | "plan") => {
    const row = refResolves(ref, rows);
    if (row) return { id: row.id, title: row.title, short_id: row.short_id };
    return isInternalId(ref) ? { id: ref, title: `a ${word} not loaded yet` } : { id: ref, title: ref, short_id: ref };
  };
  return {
    projects: (scope?.projects ?? []).map((ref) => name(ref, projects, "project")),
    plans: (scope?.plans ?? []).map((ref) => { const n = name(ref, plans, "plan"); return { id: n.id, title: n.title, short_id: n.short_id ?? n.title }; }),
  };
}

const strip = (h: string) => h.replace(/^@/, "").trim().toLowerCase();
const same = (a: string | undefined, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A ref names a project or a plan the way a proposal writes one: short id, id or title. */
export function refMatches(ref: string, row: { id: string; title: string; short_id?: string }): boolean {
  return same(row.id, ref) || same(row.title, ref) || same(row.short_id, ref);
}

/**
 * The one row a project ref names, the way the server resolves it
 * (orgRoles.resolveScopeRef): an exact id, short id or title first, else a
 * title substring when exactly one row contains it. Null when none or
 * several do. Plans resolve by pl-N or id only, so they stay on refMatches.
 */
export function refResolves<T extends { id: string; title: string; short_id?: string }>(ref: string, rows: readonly T[]): T | null {
  const exact = rows.find((r) => refMatches(ref, r));
  if (exact) return exact;
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  const loose = rows.filter((r) => r.title.toLowerCase().includes(needle));
  return loose.length === 1 ? loose[0] : null;
}

/**
 * A proposal's parent reference against a tree: "@handle" or "or-N" for a
 * role, "me" or a member's name or id for a person, a role's name or id,
 * absent = the person deciding. Null when nothing in the tree answers to it.
 * The one reading the ghosts and the hire dialog's prefill share.
 */
export function resolveOrgParentRef(tree: OrgTree, ref: string | undefined, me: OrgPerson | undefined = tree.people.find((p) => p.is_me) ?? tree.people[0]): OrgParentRef | null {
  const live = tree.roles.filter((r) => r.status !== "retired");
  const byHandle = (h: string) => live.find((x) => strip(x.handle) === strip(h));
  if (!ref || ref.trim().toLowerCase() === "me") return me ? { kind: "user", user_id: me.user_id } : null;
  const r = ref.trim();
  if (r.startsWith("@")) { const role = byHandle(r); return role ? { kind: "role", role_id: role._id } : null; }
  if (/^or-\d+$/i.test(r)) { const role = live.find((x) => same(x.short_id, r)); return role ? { kind: "role", role_id: role._id } : null; }
  const person = tree.people.find((p) => same(p.name, r) || same(p.user_id, r));
  if (person) return { kind: "user", user_id: person.user_id };
  const role = byHandle(r) ?? live.find((x) => same(x.name, r) || same(x._id, r));
  return role ? { kind: "role", role_id: role._id } : null;
}

/** The chip a change draws (its delta, with the full line as the title), as
 *  the person will accept it: their edits laid over the proposal. The scope
 *  panel's project rows draw project charters through this too. */
export function ghostChipOf(c: OrgProposalChange, unresolved = false, name: (change: OrgChange) => OrgChange = (x) => x): OrgGhostChip {
  const change = name(editedOrgChange(c.change, c.edits));
  return { change_id: c._id, status: c.status, line: changeLine(change), kind: change.kind, chip: chipLine(change), ...(unresolved ? { unresolved: true } : {}) };
}

/**
 * Merge a proposal's changes into the tree (S5). Pure: the tree is copied,
 * never mutated. Every change is drawn as the person will accept it: their
 * edits laid over the proposal (editedOrgChange). Per kind:
 * - role: a stub role under its proposed parent; ghost while proposed, solid
 *   once accepted, gone once org.tree carries a live role with the handle.
 * - move: proposed = a violet edge to the new parent (the old one fades);
 *   accepted = the row re-parented until the tree agrees.
 * - retire: proposed = an overlay on the node; accepted = the role dropped
 *   and its reports re-homed under its parent, until the tree agrees.
 * - adopt: a stub session under the role it names ("this session" when it is
 *   the viewer's), ghost or solid like a role stub.
 * - scope, budget, trust, routine: a chip on the handle's role.
 * - file: a chip on the role whose scope names the plan or project, else the
 *   viewer's own card. projects: a chip on the viewer's own card.
 * - project_meta: a chip on the role that owns or scopes the project; with
 *   neither, the scope panel's project row carries it and the canvas nothing.
 * A handle nothing live answers to (a typo, another workspace's role, a role
 * retired since) is drawn as a warning chip on the viewer's own card while the
 * change is still decidable, never dropped: what vanishes cannot be skipped.
 * An applied change whose subject is gone is history and stays silent. A kind
 * this build does not know is a chip too. Skipped changes are dropped; failed
 * ones stay decidable and are drawn as proposed with their status. A quiet
 * kind (a limit, org-staffing.md S23.2, ORG_QUIET_KINDS) draws nothing at
 * all: the pane's ask still carries it, so it is accepted or skipped with the
 * rest, but no person reads a number.
 */
export function ghostsFor(tree: OrgTree, changes: readonly OrgProposalChange[], opts: OrgGhostOptions = {}): OrgGhostPlan {
  const merged: OrgTree = { ...tree, people: tree.people.map((p) => ({ ...p })), roles: tree.roles.map((r) => ({ ...r, sessions: [...r.sessions] })), anchors: [...tree.anchors] };
  const plan: OrgGhostPlan = { merged, stubs: {}, retires: {}, moves: [], chips: {} };
  const open = changes.filter((c) => c.status !== "skipped" && c.status !== "removed");
  if (open.length === 0) return plan;
  const me = merged.people.find((p) => p.is_me) ?? merged.people[0];
  const meNode = me ? personNodeId(me.user_id) : null;
  const live = () => merged.roles.filter((r) => r.status !== "retired");
  const roleByHandle = (h: string) => live().find((r) => strip(r.handle) === strip(h));
  const decided = (c: OrgProposalChange) => c.status === "accepted" || c.status === "applied";
  const eff = (c: OrgProposalChange): OrgChange => editedOrgChange(c.change, c.edits);
  const meta = (c: OrgProposalChange): OrgGhostMeta => ({ change_id: c._id, status: c.status, line: changeLine(withScopeNames(eff(c), tree, opts)) });
  const chip = (c: OrgProposalChange, unresolved = false): OrgGhostChip => ghostChipOf(c, unresolved, (ch) => withScopeNames(ch, tree, opts));
  const chipOn = (nodeId: string | null, x: OrgGhostChip) => { if (nodeId) (plan.chips[nodeId] ??= []).push(x); };
  const orphan = (c: OrgProposalChange) => { if (c.status !== "applied") chipOn(meNode, chip(c, true)); };
  const now = Date.now();
  const resolveParent = (ref: string | undefined) => resolveOrgParentRef(merged, ref, me);

  // 1. Role stubs first (parents before children in the proposal's order), so
  //    a move, a chip or an adopt can land on a role the same proposal creates.
  const roleChanges = open.filter((c) => c.change.kind === "role");
  for (const c of roleChanges) {
    const ch = eff(c) as Extract<OrgChange, { kind: "role" }>;
    if (roleByHandle(ch.handle)) continue; // superseded: the tree carries it
    const host = me?.user_id ?? "";
    merged.roles.push({
      _id: c._id,
      short_id: "or-…",
      scope_type: merged.workspace.kind === "team" ? "team" : "user",
      ...(merged.workspace.kind === "team" ? { team_id: merged.workspace.id } : { scope_user_id: host }),
      host_user_id: host,
      name: ch.name,
      handle: strip(ch.handle),
      scope: { project_ids: ch.scope?.projects ?? [], plan_ids: ch.scope?.plans ?? [] },
      reports_to: me ? { kind: "user", user_id: me.user_id } : { kind: "user", user_id: "" },
      status: "active",
      ...(ch.charter ? { charter: ch.charter } : {}),
      ...(ch.caps ? { caps: { ...ch.caps } } : {}),
      // A proposal's role carries its tenure and face onto the ghost seat (S10,
      // S13), so the chip and the drawn avatar read the same as a live seat.
      ...(ch.tenure ? { tenure: ch.tenure } : {}),
      ...(ch.avatar ? { avatar: ch.avatar } : {}),
      trust: "direct",
      created_by: host,
      created_at: now,
      updated_at: now,
      counts: { working: 0, needs_input: 0, done: 0, dormant: 0, idle: 0 },
      sessions: [],
      total: 0,
      scope_names: ghostScopeNames(ch.scope, tree, opts),
    });
    plan.stubs[roleNodeId(c._id)] = { ...meta(c), kind: "role", solid: decided(c), ...(ch.seat ? { seat: ch.seat } : {}) };
  }
  // Parents resolve once every stub exists.
  for (const c of roleChanges) {
    const stub = merged.roles.find((r) => r._id === c._id);
    if (!stub) continue;
    const parent = resolveParent((eff(c) as Extract<OrgChange, { kind: "role" }>).reports_to);
    if (parent && !(parent.kind === "role" && parent.role_id === stub._id)) stub.reports_to = parent;
  }

  // 2. Moves and retires against the (now stubbed) tree.
  for (const c of open) {
    const ch = eff(c);
    if (ch.kind === "move") {
      const role = roleByHandle(ch.handle);
      if (!role) { orphan(c); continue; }
      const nodeId = roleNodeId(role._id);
      const to = ch.reports_to ? resolveParent(ch.reports_to) : null;
      const from = role.reports_to;
      const agrees = !to || (from.kind === to.kind && (from.kind === "user" ? from.user_id === (to as any).user_id : from.role_id === (to as any).role_id));
      if (decided(c)) {
        if (to && !agrees) role.reports_to = to;
        continue;
      }
      if (to && !agrees) plan.moves.push({ ...meta(c), nodeId, from, to });
      // A target nothing answers to is a warning on the role's own card.
      chipOn(nodeId, chip(c, !!ch.reports_to && !to));
    } else if (ch.kind === "retire") {
      const role = roleByHandle(ch.handle);
      if (!role) { orphan(c); continue; }
      if (decided(c)) {
        role.status = "retired";
        for (const r of merged.roles) if (r.reports_to.kind === "role" && r.reports_to.role_id === role._id) r.reports_to = role.reports_to;
        continue;
      }
      plan.retires[roleNodeId(role._id)] = meta(c);
    }
  }

  // 3. Adopt stubs and chips.
  const viewer = opts.viewerSession;
  const isViewer = (conv: string) => !!viewer && (same(viewer.id ?? undefined, conv) || same(viewer.short_id ?? undefined, conv));
  for (const c of open) {
    const ch = eff(c);
    if (isOrgQuietChange(ch)) continue;
    switch (ch.kind) {
      case "adopt": {
        const role = roleByHandle(ch.handle);
        if (!role) { orphan(c); break; }
        if (role.standing && (same(role.standing.short_id, ch.conversation) || same(role.standing.conversation_id, ch.conversation))) break; // superseded
        const mine = isViewer(ch.conversation);
        const session: OrgSession = {
          _id: c._id,
          short_id: ch.conversation,
          title: mine ? "This session" : "Offered session",
          agent_type: "claude",
          state: "idle",
          updated_at: now,
          org_role_id: role._id,
          subagent_count: 0,
          is_anchor: false,
        };
        role.sessions = [session, ...role.sessions];
        plan.stubs[sessionNodeId(c._id)] = { ...meta(c), kind: "adopt", solid: decided(c), this_session: mine, role_handle: role.handle };
        break;
      }
      case "scope": case "budget": case "trust": case "routine": case "authority": case "hire": {
        if (c.status === "applied") break;
        const role = roleByHandle(ch.handle);
        if (!role) { orphan(c); break; }
        chipOn(roleNodeId(role._id), chip(c));
        break;
      }
      case "file": {
        if (c.status === "applied") break;
        const role = live().find((r) => r.scope_names.plans.some((p) => refMatches(ch.plan, p)) || r.scope_names.projects.some((p) => refMatches(ch.project, p)));
        chipOn(role ? roleNodeId(role._id) : meNode, chip(c));
        break;
      }
      case "projects": {
        if (c.status === "applied") break;
        chipOn(meNode, chip(c));
        break;
      }
      case "project_meta": {
        if (c.status === "applied") break;
        const owner = ch.owner ? roleByHandle(ch.owner) : undefined;
        const role = owner ?? live().find((r) => r.scope_names.projects.some((p) => refMatches(ch.project, p)));
        if (role) chipOn(roleNodeId(role._id), chip(c));
        else if (ch.owner) orphan(c); // an owner nothing answers to
        // Else the scope panel's project row carries it (S5).
        break;
      }
      case "role": case "move": case "retire":
        break;
      default:
        // A kind this build does not know: still a change the person can decide.
        if (c.status !== "applied") chipOn(meNode, chip(c));
        break;
    }
  }
  return plan;
}
