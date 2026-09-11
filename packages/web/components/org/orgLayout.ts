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

export type OrgNodeKind = "person" | "role" | "anchor" | "session" | "cluster";

export type OrgLayoutNode =
  | { id: string; kind: "person"; x: number; y: number; w: number; h: number; person: OrgPerson; collapsed: boolean; hidden: number }
  | { id: string; kind: "role"; x: number; y: number; w: number; h: number; role: OrgRole; collapsed: boolean; hidden: number }
  | { id: string; kind: "anchor"; x: number; y: number; w: number; h: number; anchor: OrgAnchor }
  | { id: string; kind: "session"; x: number; y: number; w: number; h: number; session: OrgSession; parent: OrgParentRef }
  | { id: string; kind: "cluster"; x: number; y: number; w: number; h: number; parent: OrgParentRef; remaining: number; loaded: number; total: number; counts: StateCounts; fullyLoaded: boolean };

export type OrgLayoutEdge = { id: string; source: string; target: string; kind: "tree" | "stack" };

export type OrgLayoutView = {
  /** Node ids (person:<user_id> / role:<role_id>) whose subtree is folded. */
  collapsed: ReadonlySet<string>;
  /** Extra sessions loaded through org.sessionsUnder, keyed by parent node id. */
  expanded: Readonly<Record<string, OrgSession[]>>;
};

export const ORG_SIZES = {
  person: { w: 248, h: 92 },
  role: { w: 248, h: 104 },
  anchor: { w: 224, h: 60 },
  session: { w: 236, h: 50 },
  cluster: { w: 236, h: 58 },
  siblingGap: 44,
  levelGap: 64,
  stackGap: 8,
  rootGap: 112,
} as const;

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
  // filled by measure()
  width: number;
  height: number;
};

function stackFor(parent: OrgParentRef, bucket: { sessions: OrgSession[]; total: number; counts: StateCounts }, view: OrgLayoutView): Branch["stack"] {
  const id = parentNodeId(parent);
  const extra = view.expanded[id] ?? [];
  const seen = new Set(bucket.sessions.map((s) => s._id));
  const sessions = [...bucket.sessions, ...extra.filter((s) => !seen.has(s._id))];
  const total = Math.max(bucket.total, sessions.length);
  if (sessions.length === 0 && total === 0) return null;
  const fullyLoaded = sessions.length >= total;
  // The cluster card appears when there is more to load, and stays (as "show
  // fewer") once an expansion has grown the stack past the server's top N.
  const hasMoreNode = !fullyLoaded || extra.length > 0;
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

export function buildBranches(tree: OrgTree, view: OrgLayoutView): Branch[] {
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
      id, kind: "role", w: ORG_SIZES.role.w, h: ORG_SIZES.role.h, role: r,
      children: collapsed ? [] : kids.map(roleBranch),
      stack: collapsed ? null : stackFor({ kind: "role", role_id: r._id }, r, view),
      collapsed, hidden: 0, width: 0, height: 0,
    };
    visiting.delete(r._id);
    if (collapsed) b.hidden = kids.length + r.total + kids.reduce((n, k) => n + subtreeCount(roleBranch(k)), 0);
    return b;
  };
  const anchorBranch = (a: OrgAnchor): Branch => ({
    id: anchorNodeId(a.anchor_id), kind: "anchor", w: ORG_SIZES.anchor.w, h: ORG_SIZES.anchor.h, anchor: a,
    children: [], stack: null, collapsed: false, hidden: 0, width: 0, height: 0,
  });
  const personBranch = (p: OrgPerson): Branch => {
    const id = personNodeId(p.user_id);
    const collapsed = view.collapsed.has(id);
    const anchors = (anchorsUnderUser.get(p.user_id) ?? []).sort(byName);
    const kids = (rolesUnderUser.get(p.user_id) ?? []).sort(byName);
    const b: Branch = {
      id, kind: "person", w: ORG_SIZES.person.w, h: ORG_SIZES.person.h, person: p,
      children: collapsed ? [] : [...anchors.map(anchorBranch), ...kids.map(roleBranch)],
      stack: collapsed ? null : stackFor({ kind: "user", user_id: p.user_id }, p, view),
      collapsed, hidden: 0, width: 0, height: 0,
    };
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
  if (b.kind === "person") out.push({ id: b.id, kind: "person", x, y, w: b.w, h: b.h, person: b.person!, collapsed: b.collapsed, hidden: b.hidden });
  else if (b.kind === "role") out.push({ id: b.id, kind: "role", x, y, w: b.w, h: b.h, role: b.role!, collapsed: b.collapsed, hidden: b.hidden });
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

export function layoutOrgTree(tree: OrgTree, view: OrgLayoutView): OrgLayout {
  const roots = buildBranches(tree, view);
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
  return { nodes, edges, width: Math.max(0, x - ORG_SIZES.rootGap), height };
}

/** Axis aligned overlap test, used by the tests and the drop target search. */
export function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
