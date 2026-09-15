// Tidy tree layout for the org page. Pure: tree + view state in, positioned
// nodes and edges out. No dependency: post order subtree widths, siblings
// spaced, parents centred over their children.
//
// Shape of the tree: people are roots, side by side. Under a person hang the
// anchors they host, the roles that report to them, and a STACK of their own
// sessions (a vertical list, so a parent with eight sessions stays one column
// wide instead of eight). Roles nest the same way. A stack ends in a cluster
// card ("+N more") when the parent has more sessions than are loaded.
import type { OrgAnchor, OrgPerson, OrgRole, OrgSession, OrgTree, OrgParentRef, StateCounts } from "./orgTypes";
import type { OrgChange, OrgChangeKind, OrgChangeStatus, OrgProposalChange } from "./orgStaffingTypes";
import { changeLine } from "./orgMeta";

export type OrgNodeKind = "person" | "role" | "anchor" | "session" | "cluster";

// ---------------------------------------------------------------- ghosts
// Open proposal changes drawn INTO the tree (docs/architecture/org-staffing.md
// S5). `ghostsFor` merges them into a copy of the tree (a proposed role is a
// stub role under its proposed parent; an accepted move or retire is already
// applied) and hands back, per node id, what the cards paint on top: a ghost
// stub, a retire overlay, a proposed move, dashed chips. The layout carries
// those onto its nodes and edges so the canvas needs no second lookup.

/** One change as a card paints it: its id, status and one-line description. */
export type OrgGhostMeta = { change_id: string; status: OrgChangeStatus; line: string };
/** A dashed chip on a node: scope, budget, trust, routine, file, project_meta, and a move's own line. */
export type OrgGhostChip = OrgGhostMeta & { kind: OrgChangeKind };
/** A stub node standing for a proposed role or an offered session. `solid`
 *  once accepted: it renders as a real card until org.tree echoes the row. */
export type OrgGhostStub = OrgGhostMeta & { kind: "role" | "adopt"; solid: boolean; this_session?: boolean };
export type OrgGhostMove = OrgGhostMeta & { nodeId: string; from: OrgParentRef; to: OrgParentRef };

export type OrgGhostPlan = {
  /** The tree with the stubs pushed and the accepted moves and retires applied. Lay THIS out. */
  merged: OrgTree;
  stubs: Record<string, OrgGhostStub>;
  retires: Record<string, OrgGhostMeta>;
  moves: OrgGhostMove[];
  chips: Record<string, OrgGhostChip[]>;
};

export const EMPTY_GHOSTS: Readonly<Omit<OrgGhostPlan, "merged">> = { stubs: {}, retires: {}, moves: [], chips: {} };

type GhostDecor = { ghost?: OrgGhostStub; retire?: OrgGhostMeta; move?: OrgGhostMove; chips?: OrgGhostChip[] };

export type OrgLayoutNode =
  | ({ id: string; kind: "person"; x: number; y: number; w: number; h: number; person: OrgPerson; collapsed: boolean; hidden: number; overflow: number } & GhostDecor)
  | ({ id: string; kind: "role"; x: number; y: number; w: number; h: number; role: OrgRole; collapsed: boolean; hidden: number; overflow: number } & GhostDecor)
  | { id: string; kind: "anchor"; x: number; y: number; w: number; h: number; anchor: OrgAnchor }
  | ({ id: string; kind: "session"; x: number; y: number; w: number; h: number; session: OrgSession; parent: OrgParentRef } & GhostDecor)
  | { id: string; kind: "cluster"; x: number; y: number; w: number; h: number; parent: OrgParentRef; remaining: number; loaded: number; total: number; counts: StateCounts; fullyLoaded: boolean };

/** `ghost`: a dashed edge into a stub, or a proposed move's edge to the new
 *  parent (then `change_id` names the move). `faded`: the old edge of a
 *  proposed move, drawn at 30%. */
export type OrgLayoutEdge = { id: string; source: string; target: string; kind: "tree" | "stack" | "ghost"; faded?: boolean; change_id?: string };

export type OrgLayoutView = {
  /** Node ids (person:<user_id> / role:<role_id>) whose subtree is folded. */
  collapsed: ReadonlySet<string>;
  /** Sessions loaded through org.sessionsUnder, keyed by parent node id. A key
   *  that is present (even with an empty list) means "show every loaded
   *  session", not just the first ORG_STACK_VISIBLE. */
  expanded: Readonly<Record<string, OrgSession[]>>;
};

export const ORG_SIZES = {
  person: { w: 232, h: 96 },
  role: { w: 232, h: 108 },
  anchor: { w: 208, h: 60 },
  session: { w: 220, h: 50 },
  cluster: { w: 220, h: 58 },
  /** Extra card height when a node carries ghost chips. */
  chipRow: 24,
  siblingGap: 40,
  levelGap: 56,
  stackGap: 8,
  rootGap: 96,
} as const;

/** Sessions drawn under a parent before the cluster card takes over. The tree
 *  payload carries TOP_N (8); the first click on the cluster reveals the rest
 *  of the payload, later clicks page org.sessionsUnder. */
export const ORG_STACK_VISIBLE = 5;

export const personNodeId = (userId: string) => `person:${userId}`;
export const roleNodeId = (roleId: string) => `role:${roleId}`;
export const anchorNodeId = (anchorId: string) => `anchor:${anchorId}`;
export const sessionNodeId = (conversationId: string) => `session:${conversationId}`;
export const clusterNodeId = (parentId: string) => `cluster:${parentId}`;

export function parentNodeId(ref: OrgParentRef): string {
  return ref.kind === "user" ? personNodeId(ref.user_id) : roleNodeId(ref.role_id);
}

export function parentRefOfNodeId(id: string): OrgParentRef | null {
  if (id.startsWith("person:")) return { kind: "user", user_id: id.slice("person:".length) };
  if (id.startsWith("role:")) return { kind: "role", role_id: id.slice("role:".length) };
  return null;
}

// ---------------------------------------------------------------- hierarchy

type Branch = {
  id: string;
  kind: "person" | "role" | "anchor";
  w: number;
  h: number;
  person?: OrgPerson;
  role?: OrgRole;
  anchor?: OrgAnchor;
  children: Branch[];
  /** The parent's own sessions, drawn as a vertical stack under it. */
  stack: { parent: OrgParentRef; sessions: OrgSession[]; total: number; counts: StateCounts; hasMoreNode: boolean; fullyLoaded: boolean } | null;
  collapsed: boolean;
  /** Everything folded away under a collapsed node, for the card's count. */
  hidden: number;
  /** Sessions the stack does not draw (total minus drawn), for the card's tally. */
  overflow: number;
  // filled by measure()
  width: number;
  height: number;
};

/**
 * Every session id that any bucket in the tree files. A loaded page (view
 * .expanded) can hold a row the tree meanwhile filed elsewhere (a move that
 * echoed before the page pruned it); the tree's own bucket wins and the page
 * copy is not drawn, so one session is never two nodes.
 */
function bucketedIds(tree: OrgTree): Set<string> {
  const out = new Set<string>();
  for (const b of [...tree.people, ...tree.roles]) for (const s of b.sessions) out.add(s._id);
  return out;
}

function stackFor(parent: OrgParentRef, bucket: { sessions: OrgSession[]; total: number; counts: StateCounts }, view: OrgLayoutView, elsewhere: ReadonlySet<string>): Branch["stack"] {
  const id = parentNodeId(parent);
  const opened = id in view.expanded;
  const extra = view.expanded[id] ?? [];
  const seen = new Set(bucket.sessions.map((s) => s._id));
  const loaded = [...bucket.sessions, ...extra.filter((s) => !seen.has(s._id) && !elsewhere.has(s._id))];
  const total = Math.max(bucket.total, loaded.length);
  if (loaded.length === 0 && total === 0) return null;
  const sessions = opened ? loaded : loaded.slice(0, ORG_STACK_VISIBLE);
  const fullyLoaded = sessions.length >= total;
  // The cluster card appears when there is more to show, and stays (as "show
  // fewer") once the stack has been opened past the default five.
  const hasMoreNode = !fullyLoaded || opened;
  return { parent, sessions, total, counts: bucket.counts, hasMoreNode, fullyLoaded };
}

function stackHeight(stack: NonNullable<Branch["stack"]>): number {
  const n = stack.sessions.length + (stack.hasMoreNode ? 1 : 0);
  if (n === 0) return 0;
  return stack.sessions.length * (ORG_SIZES.session.h + ORG_SIZES.stackGap) + (stack.hasMoreNode ? ORG_SIZES.cluster.h + ORG_SIZES.stackGap : 0) - ORG_SIZES.stackGap;
}

function subtreeCount(b: Branch): number {
  let n = b.children.length + (b.stack ? b.stack.total : 0);
  for (const c of b.children) n += subtreeCount(c);
  return n;
}

export function buildBranches(tree: OrgTree, view: OrgLayoutView, ghosts?: Pick<OrgGhostPlan, "chips">): Branch[] {
  const filed = bucketedIds(tree);
  const chipRow = (id: string) => (ghosts?.chips[id]?.length ? ORG_SIZES.chipRow : 0);
  // An anchor's bot is a team member too, but it is drawn as the anchor card,
  // never as a person: its one session is emitted under `anchors`.
  const botIds = new Set(tree.anchors.map((a) => a.bot_user_id));
  const people = tree.people
    .filter((p) => !botIds.has(p.user_id))
    .sort((a, b) => Number(b.is_me) - Number(a.is_me) || a.name.localeCompare(b.name));
  const roles = tree.roles.filter((r) => r.status !== "retired");
  const roleIds = new Set(roles.map((r) => r._id));
  const personIds = new Set(people.map((p) => p.user_id));

  const rolesUnderUser = new Map<string, OrgRole[]>();
  const rolesUnderRole = new Map<string, OrgRole[]>();
  const orphanRoles: OrgRole[] = [];
  for (const r of roles) {
    const rt = r.reports_to;
    if (rt.kind === "user" && personIds.has(rt.user_id)) {
      rolesUnderUser.set(rt.user_id, [...(rolesUnderUser.get(rt.user_id) ?? []), r]);
    } else if (rt.kind === "role" && roleIds.has(rt.role_id) && rt.role_id !== r._id) {
      rolesUnderRole.set(rt.role_id, [...(rolesUnderRole.get(rt.role_id) ?? []), r]);
    } else {
      orphanRoles.push(r);
    }
  }
  const anchorsUnderUser = new Map<string, OrgAnchor[]>();
  const orphanAnchors: OrgAnchor[] = [];
  for (const a of tree.anchors) {
    if (a.status === "decommissioned") continue;
    if (personIds.has(a.host_user_id)) anchorsUnderUser.set(a.host_user_id, [...(anchorsUnderUser.get(a.host_user_id) ?? []), a]);
    else orphanAnchors.push(a);
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const visiting = new Set<string>();

  const roleBranch = (r: OrgRole): Branch => {
    const id = roleNodeId(r._id);
    const collapsed = view.collapsed.has(id);
    // A cycle in reports_to (refused server side, but never trust a snapshot)
    // would recurse forever: cut it here.
    const kids = visiting.has(r._id) ? [] : (rolesUnderRole.get(r._id) ?? []).sort(byName);
    visiting.add(r._id);
    const b: Branch = {
      id, kind: "role", w: ORG_SIZES.role.w, h: ORG_SIZES.role.h + chipRow(id), role: r,
      children: collapsed ? [] : kids.map(roleBranch),
      stack: collapsed ? null : stackFor({ kind: "role", role_id: r._id }, r, view, filed),
      collapsed, hidden: 0, overflow: 0, width: 0, height: 0,
    };
    b.overflow = b.stack ? Math.max(0, b.stack.total - b.stack.sessions.length) : collapsed ? r.total : 0;
    visiting.delete(r._id);
    if (collapsed) b.hidden = kids.length + r.total + kids.reduce((n, k) => n + subtreeCount(roleBranch(k)), 0);
    return b;
  };
  const anchorBranch = (a: OrgAnchor): Branch => ({
    id: anchorNodeId(a.anchor_id), kind: "anchor", w: ORG_SIZES.anchor.w, h: ORG_SIZES.anchor.h, anchor: a,
    children: [], stack: null, collapsed: false, hidden: 0, overflow: 0, width: 0, height: 0,
  });
  const personBranch = (p: OrgPerson): Branch => {
    const id = personNodeId(p.user_id);
    const collapsed = view.collapsed.has(id);
    const anchors = (anchorsUnderUser.get(p.user_id) ?? []).sort(byName);
    const kids = (rolesUnderUser.get(p.user_id) ?? []).sort(byName);
    const b: Branch = {
      id, kind: "person", w: ORG_SIZES.person.w, h: ORG_SIZES.person.h + chipRow(id), person: p,
      children: collapsed ? [] : [...anchors.map(anchorBranch), ...kids.map(roleBranch)],
      stack: collapsed ? null : stackFor({ kind: "user", user_id: p.user_id }, p, view, filed),
      collapsed, hidden: 0, overflow: 0, width: 0, height: 0,
    };
    b.overflow = b.stack ? Math.max(0, b.stack.total - b.stack.sessions.length) : collapsed ? p.total : 0;
    if (collapsed) b.hidden = anchors.length + kids.length + p.total + kids.reduce((n, k) => n + subtreeCount(roleBranch(k)), 0);
    return b;
  };

  return [
    ...people.map(personBranch),
    ...orphanRoles.sort(byName).map(roleBranch),
    ...orphanAnchors.sort(byName).map(anchorBranch),
  ];
}

// ---------------------------------------------------------------- measure + place

function measure(b: Branch): void {
  for (const c of b.children) measure(c);
  const parts: number[] = b.children.map((c) => c.width);
  if (b.stack) parts.push(ORG_SIZES.session.w);
  const childrenWidth = parts.length ? parts.reduce((a, w) => a + w, 0) + ORG_SIZES.siblingGap * (parts.length - 1) : 0;
  b.width = Math.max(b.w, childrenWidth);
  const childHeights = b.children.map((c) => c.height);
  if (b.stack) childHeights.push(stackHeight(b.stack));
  const below = childHeights.length ? Math.max(...childHeights) : 0;
  b.height = b.h + (below > 0 ? ORG_SIZES.levelGap + below : 0);
}

function place(b: Branch, left: number, top: number, out: OrgLayoutNode[], edges: OrgLayoutEdge[]): void {
  const x = left + (b.width - b.w) / 2;
  const y = top;
  if (b.kind === "person") out.push({ id: b.id, kind: "person", x, y, w: b.w, h: b.h, person: b.person!, collapsed: b.collapsed, hidden: b.hidden, overflow: b.overflow });
  else if (b.kind === "role") out.push({ id: b.id, kind: "role", x, y, w: b.w, h: b.h, role: b.role!, collapsed: b.collapsed, hidden: b.hidden, overflow: b.overflow });
  else out.push({ id: b.id, kind: "anchor", x, y, w: b.w, h: b.h, anchor: b.anchor! });

  const parts: number[] = b.children.map((c) => c.width);
  if (b.stack) parts.push(ORG_SIZES.session.w);
  if (parts.length === 0) return;
  const childrenWidth = parts.reduce((a, w) => a + w, 0) + ORG_SIZES.siblingGap * (parts.length - 1);
  let cx = left + (b.width - childrenWidth) / 2;
  const cy = y + b.h + ORG_SIZES.levelGap;
  for (const c of b.children) {
    place(c, cx, cy, out, edges);
    edges.push({ id: `e:${b.id}->${c.id}`, source: b.id, target: c.id, kind: "tree" });
    cx += c.width + ORG_SIZES.siblingGap;
  }
  if (b.stack) {
    const st = b.stack;
    let sy = cy;
    let prev = b.id;
    st.sessions.forEach((s, i) => {
      const id = sessionNodeId(s._id);
      out.push({ id, kind: "session", x: cx, y: sy, w: ORG_SIZES.session.w, h: ORG_SIZES.session.h, session: s, parent: st.parent });
      edges.push({ id: `e:${prev}->${id}`, source: prev, target: id, kind: i === 0 ? "tree" : "stack" });
      prev = id;
      sy += ORG_SIZES.session.h + ORG_SIZES.stackGap;
    });
    if (st.hasMoreNode) {
      const id = clusterNodeId(b.id);
      out.push({
        id, kind: "cluster", x: cx, y: sy, w: ORG_SIZES.cluster.w, h: ORG_SIZES.cluster.h, parent: st.parent,
        remaining: Math.max(0, st.total - st.sessions.length), loaded: st.sessions.length, total: st.total, counts: st.counts, fullyLoaded: st.fullyLoaded,
      });
      edges.push({ id: `e:${prev}->${id}`, source: prev, target: id, kind: st.sessions.length ? "stack" : "tree" });
    }
  }
}

export type OrgLayout = { nodes: OrgLayoutNode[]; edges: OrgLayoutEdge[]; width: number; height: number };

/**
 * Lay the tree out. With `ghosts` (from `ghostsFor`, built from the SAME
 * tree) the merged tree is laid out instead and every node and edge carries
 * its ghost decoration: stubs, retire overlays, chips, the dashed edge of a
 * proposed move and the faded old one.
 */
export function layoutOrgTree(tree: OrgTree, view: OrgLayoutView, ghosts?: OrgGhostPlan): OrgLayout {
  const roots = buildBranches(ghosts?.merged ?? tree, view, ghosts);
  for (const r of roots) measure(r);
  const nodes: OrgLayoutNode[] = [];
  const edges: OrgLayoutEdge[] = [];
  let x = 0;
  let height = 0;
  for (const r of roots) {
    place(r, x, 0, nodes, edges);
    x += r.width + ORG_SIZES.rootGap;
    height = Math.max(height, r.height);
  }
  if (ghosts) decorate(nodes, edges, ghosts);
  return { nodes, edges, width: Math.max(0, x - ORG_SIZES.rootGap), height };
}

function decorate(nodes: OrgLayoutNode[], edges: OrgLayoutEdge[], ghosts: OrgGhostPlan): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moveOf = new Map(ghosts.moves.map((m) => [m.nodeId, m]));
  for (const n of nodes) {
    if (n.kind === "anchor" || n.kind === "cluster") continue;
    const stub = ghosts.stubs[n.id];
    if (stub) n.ghost = stub;
    const chips = ghosts.chips[n.id];
    if (chips?.length) n.chips = chips;
    if (n.kind !== "role") continue;
    const retire = ghosts.retires[n.id];
    if (retire) n.retire = retire;
    const move = moveOf.get(n.id);
    if (move) n.move = move;
  }
  // The edge into a proposed (not yet accepted) stub is drawn as a ghost too.
  for (const e of edges) {
    const stub = ghosts.stubs[e.target];
    if (stub && !stub.solid && e.kind === "tree") e.kind = "ghost";
  }
  for (const m of ghosts.moves) {
    if (!byId.has(m.nodeId)) continue;
    const to = parentNodeId(m.to);
    if (!byId.has(to)) continue;
    const old = edges.find((e) => e.target === m.nodeId && e.kind !== "stack");
    if (old) old.faded = true;
    edges.push({ id: `g:${m.change_id}`, source: to, target: m.nodeId, kind: "ghost", change_id: m.change_id });
  }
}

/** The node a change is drawn on, for focus: its stub, its subject, or the
 *  node carrying its chip. Null when the change has no place on the chart. */
export function ghostNodeIdFor(ghosts: OrgGhostPlan | null | undefined, changeId: string | null | undefined): string | null {
  if (!ghosts || !changeId) return null;
  for (const [id, s] of Object.entries(ghosts.stubs)) if (s.change_id === changeId) return id;
  for (const [id, r] of Object.entries(ghosts.retires)) if (r.change_id === changeId) return id;
  const move = ghosts.moves.find((m) => m.change_id === changeId);
  if (move) return move.nodeId;
  for (const [id, chips] of Object.entries(ghosts.chips)) if (chips.some((c) => c.change_id === changeId)) return id;
  return null;
}

// ---------------------------------------------------------------- ghostsFor

export type OrgGhostOptions = {
  /** The session the viewer is looking from (id or short id): an adopt
   *  change offering it reads "this session". */
  viewerSession?: { id?: string | null; short_id?: string | null } | null;
};

const strip = (h: string) => h.replace(/^@/, "").trim().toLowerCase();
const same = (a: string | undefined, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A ref names a project or a plan the way a proposal writes one: short id, id or title. */
function refMatches(ref: string, row: { id: string; title: string; short_id?: string }): boolean {
  return same(row.id, ref) || same(row.title, ref) || same(row.short_id, ref);
}

/**
 * Merge a proposal's changes into the tree (S5). Pure: the tree is copied,
 * never mutated. Per kind:
 * - role: a stub role under its proposed parent; ghost while proposed, solid
 *   once accepted, gone once org.tree carries a live role with the handle.
 * - move: proposed = a dashed edge to the new parent (the old one fades);
 *   accepted = the row re-parented until the tree agrees.
 * - retire: proposed = an overlay on the node; accepted = the role dropped
 *   and its reports re-homed under its parent, until the tree agrees.
 * - adopt: a stub session under the role it names ("this session" when it is
 *   the viewer's), ghost or solid like a role stub.
 * - scope, budget, trust, routine, file, project_meta: a chip on the node the
 *   change belongs to (the handle's role, the owner role, the role whose scope
 *   names the project or plan, else the viewer's own card). Dashed while
 *   proposed, solid once accepted, dropped once applied.
 * Skipped changes are dropped; failed ones stay decidable and are drawn as
 * proposed with their status.
 */
export function ghostsFor(tree: OrgTree, changes: readonly OrgProposalChange[], opts: OrgGhostOptions = {}): OrgGhostPlan {
  const merged: OrgTree = { ...tree, people: tree.people.map((p) => ({ ...p })), roles: tree.roles.map((r) => ({ ...r, sessions: [...r.sessions] })), anchors: [...tree.anchors] };
  const plan: OrgGhostPlan = { merged, stubs: {}, retires: {}, moves: [], chips: {} };
  const open = changes.filter((c) => c.status !== "skipped");
  if (open.length === 0) return plan;
  const me = merged.people.find((p) => p.is_me) ?? merged.people[0];
  const meNode = me ? personNodeId(me.user_id) : null;
  const live = () => merged.roles.filter((r) => r.status !== "retired");
  const roleByHandle = (h: string) => live().find((r) => strip(r.handle) === strip(h));
  const decided = (c: OrgProposalChange) => c.status === "accepted" || c.status === "applied";
  const meta = (c: OrgProposalChange): OrgGhostMeta => ({ change_id: c._id, status: c.status, line: changeLine(c.change) });
  const now = Date.now();

  /** "@handle", "or-N", "me", a member's name, or absent (= the person deciding). */
  const resolveParent = (ref: string | undefined): OrgParentRef | null => {
    if (!ref || ref.trim().toLowerCase() === "me") return me ? { kind: "user", user_id: me.user_id } : null;
    const r = ref.trim();
    if (r.startsWith("@")) { const role = roleByHandle(r); return role ? { kind: "role", role_id: role._id } : null; }
    if (/^or-\d+$/i.test(r)) { const role = live().find((x) => same(x.short_id, r)); return role ? { kind: "role", role_id: role._id } : null; }
    const person = merged.people.find((p) => same(p.name, r) || same(p.user_id, r));
    if (person) return { kind: "user", user_id: person.user_id };
    const role = roleByHandle(r) ?? live().find((x) => same(x.name, r) || same(x._id, r));
    return role ? { kind: "role", role_id: role._id } : null;
  };

  // 1. Role stubs first (parents before children in the proposal's order), so
  //    a move, a chip or an adopt can land on a role the same proposal creates.
  const roleChanges = open.filter((c) => c.change.kind === "role");
  for (const c of roleChanges) {
    const ch = c.change as Extract<OrgChange, { kind: "role" }>;
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
      ...(ch.caps ? { caps: { hands_per_day: ch.caps.hands_per_day ?? 0, wakes_per_day: ch.caps.wakes_per_day ?? 0, tokens_per_day: ch.caps.tokens_per_day ?? 0 } } : {}),
      trust: "understand",
      created_by: host,
      created_at: now,
      updated_at: now,
      counts: { working: 0, needs_input: 0, done: 0, dormant: 0, idle: 0 },
      sessions: [],
      total: 0,
      scope_names: {
        projects: (ch.scope?.projects ?? []).map((ref) => ({ id: ref, title: ref })),
        plans: (ch.scope?.plans ?? []).map((ref) => ({ id: ref, title: ref, short_id: ref })),
      },
    });
    plan.stubs[roleNodeId(c._id)] = { ...meta(c), kind: "role", solid: decided(c) };
  }
  // Parents resolve once every stub exists.
  for (const c of roleChanges) {
    const stub = merged.roles.find((r) => r._id === c._id);
    if (!stub) continue;
    const parent = resolveParent((c.change as Extract<OrgChange, { kind: "role" }>).reports_to);
    if (parent && !(parent.kind === "role" && parent.role_id === stub._id)) stub.reports_to = parent;
  }

  // 2. Moves and retires against the (now stubbed) tree.
  for (const c of open) {
    if (c.change.kind === "move") {
      const role = roleByHandle(c.change.handle);
      if (!role) continue;
      const nodeId = roleNodeId(role._id);
      const to = c.change.reports_to ? resolveParent(c.change.reports_to) : null;
      const from = role.reports_to;
      const agrees = !to || (from.kind === to.kind && (from.kind === "user" ? from.user_id === (to as any).user_id : from.role_id === (to as any).role_id));
      if (decided(c)) {
        if (to && !agrees) role.reports_to = to;
        continue;
      }
      if (to && !agrees) plan.moves.push({ ...meta(c), nodeId, from, to });
      (plan.chips[nodeId] ??= []).push({ ...meta(c), kind: "move" });
    } else if (c.change.kind === "retire") {
      const role = roleByHandle(c.change.handle);
      if (!role) continue; // superseded: already gone
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
    const ch = c.change;
    switch (ch.kind) {
      case "adopt": {
        const role = roleByHandle(ch.handle);
        if (!role) break;
        if (role.standing && (same(role.standing.short_id, ch.conversation) || same(role.standing.conversation_id, ch.conversation))) break; // superseded
        const mine = isViewer(ch.conversation);
        const session: OrgSession = {
          _id: c._id,
          short_id: ch.conversation,
          title: mine ? "This session" : `Session ${ch.conversation}`,
          agent_type: "claude",
          state: "idle",
          updated_at: now,
          org_role_id: role._id,
          subagent_count: 0,
          is_anchor: false,
        };
        role.sessions = [session, ...role.sessions];
        plan.stubs[sessionNodeId(c._id)] = { ...meta(c), kind: "adopt", solid: decided(c), this_session: mine };
        break;
      }
      case "scope": case "budget": case "trust": case "routine": {
        if (c.status === "applied") break;
        const role = roleByHandle(ch.handle);
        const nodeId = role ? roleNodeId(role._id) : meNode;
        if (nodeId) (plan.chips[nodeId] ??= []).push({ ...meta(c), kind: ch.kind });
        break;
      }
      case "file": {
        if (c.status === "applied") break;
        const role = live().find((r) => r.scope_names.plans.some((p) => refMatches(ch.plan, p)) || r.scope_names.projects.some((p) => refMatches(ch.project, p)));
        const nodeId = role ? roleNodeId(role._id) : meNode;
        if (nodeId) (plan.chips[nodeId] ??= []).push({ ...meta(c), kind: "file" });
        break;
      }
      case "project_meta": {
        if (c.status === "applied") break;
        const role = (ch.owner ? roleByHandle(ch.owner) : undefined) ?? live().find((r) => r.scope_names.projects.some((p) => refMatches(ch.project, p)));
        const nodeId = role ? roleNodeId(role._id) : meNode;
        if (nodeId) (plan.chips[nodeId] ??= []).push({ ...meta(c), kind: "project_meta" });
        break;
      }
      default:
        break;
    }
  }
  return plan;
}

/** Axis aligned overlap test, used by the tests and the drop target search. */
export function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
