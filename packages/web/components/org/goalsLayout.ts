// The Goals lens of the org chart (docs/architecture/org-staffing.md S36).
// Pure: the org tree, the workspace's initiatives and projects and the open
// proposal's changes in, positioned nodes and edges out.
//
// Shape: an outline on the left (the company, its top level goals, the goals
// that feed them, the projects that carry each) and a column of owners on the
// right, one card per person or role, with an edge from every goal to its
// owner and from every project to its lead. The edges run through the empty
// space between the two columns, so none crosses a card.
//
// The outline is drawn AS IT WILL BE once the open proposal is accepted, each
// changed thing in ghost chrome. What a goal change names (its goal, parent,
// owner, former parent) is read off `proposalChangeRows`, the rows the
// proposal card joins and nests, so the chart and the card cannot disagree.
import type { InitiativeOwner, InitiativeRow } from "@codecast/shared/contracts/initiative";
import { metricReadings, type MetricReading } from "@codecast/shared/contracts/initiative";
import { editedOrgChange, ORG_GOAL_KINDS, type OrgChangeKind } from "@codecast/shared/contracts/orgProposal";
import { projectLeadOf } from "@codecast/shared/contracts/orgLead";
import { byListOrder } from "../../lib/initiatives";
import type { OrgTree } from "./orgTypes";
import type { OrgProposalChange } from "./orgStaffingTypes";
import { ghostScopeNames, personNodeId, roleNodeId, type OrgGhostChip, type OrgGhostMeta } from "./orgLayout";
import { proposalChangeRows, type ProposalTreeFace, type ProposalTreeRow } from "./proposalTree";

/** What the lens reads off a project row. */
export type GoalProject = { _id: string; title: string; short_id?: string; status?: string; owner_role_id?: string };

/** A change as a goal or project card wears it: the tag it leads with, and
 *  whether it is accepted (drawn solid until the store carries it). */
export type GoalGhost = OrgGhostMeta & { tag: string | null; solid: boolean; unresolved?: boolean };

/** Who owns a goal or leads a project: a person, a role (live, or one this
 *  proposal creates), or a name nothing in the workspace answers to. */
export type GoalOwner = Extract<ProposalTreeFace, { kind: "person" | "role" | "unknown" }>;

export type GoalsInput = {
  tree: OrgTree;
  initiatives: readonly InitiativeRow[];
  projects: readonly GoalProject[];
  /** The open proposal's changes; absent, the lens draws what is. */
  changes?: readonly OrgProposalChange[];
};

// ---------------------------------------------------------------- the plan

export type PlanProject = { id: string; title: string; short_id?: string; status?: string; lead: GoalOwner | null; ghost?: GoalGhost };
export type PlanGoal = {
  id: string;
  title: string;
  short_id?: string;
  /** The live row; absent on a goal this proposal sets. */
  row?: InitiativeRow;
  parentId: string | null;
  owner: GoalOwner | null;
  projects: PlanProject[];
  /** The goal is new, or lands somewhere new. */
  ghost?: GoalGhost;
  /** Deltas on the goal that are neither: its metrics, its owner. */
  chips: OrgGhostChip[];
  /** A re-placed goal: where it sat before. */
  was?: string;
  /** The owner edge is this change's. */
  ownerGhost?: GoalGhost;
  /** The owner before an owner change, for the faded edge. */
  formerOwner?: GoalOwner | null;
};

const GOAL_KINDS = new Set<OrgChangeKind>(ORG_GOAL_KINDS);
const DRAWN = new Set(["proposed", "failed", "accepted"]);
const ownerOfFace = (f: ProposalTreeFace | null | undefined): GoalOwner | null => (f && (f.kind === "person" || f.kind === "role" || f.kind === "unknown") ? f : null);

/** A live owner as a face, from the tree in hand. */
function liveOwner(tree: OrgTree, owner: InitiativeOwner | undefined): GoalOwner | null {
  if (!owner) return null;
  if (owner.kind === "user") {
    const p = tree.people.find((x) => x.user_id === owner.user_id);
    return p ? { kind: "person", id: p.user_id, name: p.name, image: p.image, me: p.is_me } : { kind: "unknown", id: owner.user_id, name: "Someone not on this chart" };
  }
  const r = tree.roles.find((x) => x._id === owner.role_id && x.status !== "retired");
  return r ? { kind: "role", id: r._id, name: r.name, handle: r.handle, avatar: r.avatar } : { kind: "unknown", id: owner.role_id, name: "A role not on this chart" };
}

/**
 * The goal tree after the proposal: live goals that are still being reached
 * (cancelled and completed ones are history), with every drawn goal change
 * laid over them in the proposal's order. Applied and skipped changes draw
 * nothing: the store already carries the first and the second is not coming.
 */
export function goalsPlan({ tree, initiatives, projects, changes = [] }: GoalsInput): { goals: PlanGoal[]; changeGoal: Record<string, string> } {
  const projectRows = projects.map((p) => ({ id: p._id, title: p.title, short_id: p.short_id }));
  const projectById = new Map(projects.map((p) => [p._id, p]));
  const leadOf = (id: string): GoalOwner | null => {
    const p = projectById.get(id);
    const lead = p ? projectLeadOf(p, tree.roles) : null;
    return lead?.kind === "lead" ? { kind: "role", id: lead.role._id, name: lead.role.name, handle: lead.role.handle, avatar: lead.role.avatar } : null;
  };
  const carried = (refs: readonly string[], ghost?: GoalGhost): PlanProject[] =>
    ghostScopeNames({ projects: refs }, tree, { projects: projectRows }).projects.map((p) => ({ id: p.id, title: p.title, short_id: p.short_id, status: projectById.get(p.id)?.status, lead: leadOf(p.id), ...(ghost ? { ghost } : {}) }));

  const goals: PlanGoal[] = [...initiatives]
    .filter((g) => g.status !== "cancelled" && g.status !== "completed")
    .sort(byListOrder)
    .map((g) => ({ id: g._id, title: g.title, short_id: g.short_id, row: g, parentId: g.parent_initiative_id ?? null, owner: liveOwner(tree, g.owner), projects: carried(g.project_ids), chips: [] }));
  const byId = new Map(goals.map((g) => [g.id, g]));
  const changeGoal: Record<string, string> = {};

  const changeById = new Map(changes.map((c) => [c._id, c]));
  const rows = proposalChangeRows(tree, changes, { goals: initiatives, projects: projectRows }).filter((r) => GOAL_KINDS.has(r.kind) && DRAWN.has(r.status));
  // A row's `unresolved` is about its owner (proposalTree), so only an owner edge wears it.
  const metaOf = (r: ProposalTreeRow, tag: string | null, owner = false): GoalGhost => ({ change_id: r.change_id, status: r.status, line: r.line, tag, solid: r.status === "accepted", ...(owner && r.unresolved ? { unresolved: true } : {}) });
  const chipOf = (r: ProposalTreeRow, chip: string): OrgGhostChip => ({ change_id: r.change_id, status: r.status, line: r.line, kind: r.kind, chip, ...(r.unresolved ? { unresolved: true } : {}) });
  // A goal a change names that nothing live or proposed answers to is still
  // a change the person can decide: it is drawn, at the top, as a warning.
  const goalFor = (r: ProposalTreeRow): PlanGoal => {
    const known = byId.get(r.node.id);
    if (known) return known;
    const g: PlanGoal = { id: r.node.id, title: r.node.name, parentId: null, owner: null, projects: [], chips: [], ghost: { ...metaOf(r, "unknown"), unresolved: true } };
    goals.push(g);
    byId.set(g.id, g);
    return g;
  };

  // Goals set here first, so a later row that names one lands on it whatever the order.
  for (const r of [...rows.filter((x) => x.kind === "initiative"), ...rows.filter((x) => x.kind !== "initiative")]) {
    const c = changeById.get(r.change_id);
    if (!c) continue;
    const ch = editedOrgChange(c.change, c.edits);
    switch (ch.kind) {
      case "initiative": {
        // Superseded: the store already carries a goal with this title.
        const lc = ch.title.trim().toLowerCase();
        const live = goals.find((g) => g.row && g.title.trim().toLowerCase() === lc);
        if (live) { changeGoal[r.change_id] = live.id; break; }
        const ghost = metaOf(r, r.tag);
        const owner = ownerOfFace(r.owner);
        const g: PlanGoal = {
          id: r.node.id, title: r.node.name, parentId: r.parent?.id ?? null, owner,
          projects: carried(ch.projects, { ...ghost, tag: null }), ghost,
          chips: ch.metrics?.length ? [chipOf(r, ch.metrics.map((m) => `${m.name.trim()} ${m.target.trim()}`).join(", "))] : [],
          ...(owner ? { ownerGhost: metaOf(r, r.tag, true) } : {}),
        };
        goals.push(g);
        byId.set(g.id, g);
        changeGoal[r.change_id] = g.id;
        break;
      }
      case "initiative_shape": {
        const g = goalFor(r);
        changeGoal[r.change_id] = g.id;
        if (ch.parent !== undefined) {
          g.parentId = r.parent?.id ?? null;
          if (r.from) g.was = r.from.name;
          g.ghost ??= metaOf(r, r.tag);
        }
        if (ch.metrics !== undefined) g.chips.push(chipOf(r, r.detail ?? "no number"));
        break;
      }
      case "initiative_projects": {
        const g = goalFor(r);
        changeGoal[r.change_id] = g.id;
        const have = new Set(g.projects.map((p) => p.id));
        g.projects.push(...carried(ch.projects, metaOf(r, "added")).filter((p) => !have.has(p.id)));
        break;
      }
      case "initiative_owner": {
        const g = goalFor(r);
        changeGoal[r.change_id] = g.id;
        const owner = ownerOfFace(r.owner);
        g.formerOwner = g.owner;
        g.owner = owner;
        g.ownerGhost = metaOf(r, r.tag, true);
        g.chips.push(chipOf(r, owner ? `owner ${owner.name}` : "no owner"));
        break;
      }
    }
  }
  // A parent that is not drawn (cancelled, another workspace) leaves the goal at the top.
  for (const g of goals) if (g.parentId && (!byId.has(g.parentId) || g.parentId === g.id)) g.parentId = null;
  return { goals, changeGoal };
}

// ---------------------------------------------------------------- the layout

export const GOALS_SIZES = {
  company: { w: 264, h: 56 },
  goal: { w: 288, h: 58 },
  /** A goal's title is a sentence: past this many characters it takes a second line. */
  titleChars: 30,
  titleRow: 16,
  project: { w: 244, h: 38 },
  owner: { w: 204, h: 46 },
  /** A card's indent under its parent, and the spine's own inset from the parent's left edge. */
  indent: 30,
  spineInset: 15,
  rowGap: 10,
  /** The gap above a top level goal: each is its own block. */
  blockGap: 26,
  /** Extra goal height: a metric read against its target, a chips row, the "was under" line. */
  metricRow: 18,
  chipRow: 24,
  wasRow: 16,
  /** The empty band the owner edges cross. */
  ownerGap: 170,
  /** How far past the outline an owner edge runs straight before it curves. */
  ownerLead: 12,
  ownerRowGap: 12,
} as const;

export const COMPANY_NODE_ID = "company";
export const goalNodeId = (id: string) => `goal:${id}`;
export const projectNodeId = (goalId: string, projectId: string) => `project:${goalId}:${projectId}`;
export const ownerNodeId = (o: GoalOwner) => (o.kind === "person" ? personNodeId(o.id) : o.kind === "role" ? roleNodeId(o.id) : `owner:${o.id}`);

type Box = { id: string; x: number; y: number; w: number; h: number };
export type GoalsNode =
  | (Box & { kind: "company"; name: string; goals: number; projects: number })
  | (Box & { kind: "goal"; goal: PlanGoal; metric: MetricReading | null })
  | (Box & { kind: "project"; project: PlanProject })
  | (Box & { kind: "owner"; owner: GoalOwner; owns: number });

/** `spine`: parent to child down the outline. `owner`: a goal or project to
 *  who answers for it. `ghost` is a proposed edge, `faded` the one it replaces. */
export type GoalsEdge = { id: string; source: string; target: string; kind: "spine" | "owner"; ghost?: boolean; faded?: boolean };

export type GoalsLayout = {
  nodes: GoalsNode[];
  edges: GoalsEdge[];
  width: number;
  height: number;
  /** The node a change is drawn on, for focus. */
  changeNode: Record<string, string>;
  /** The x every owner edge runs out to before it turns toward its owner:
   *  past the deepest row, so an edge from a shallow row never crosses one. */
  ownerLane: number;
};

const goalHeight = (g: PlanGoal, metric: MetricReading | null) =>
  GOALS_SIZES.goal.h + (g.title.length > GOALS_SIZES.titleChars ? GOALS_SIZES.titleRow : 0) + (metric ? GOALS_SIZES.metricRow : 0) + (g.chips.length ? GOALS_SIZES.chipRow : 0) + (g.was ? GOALS_SIZES.wasRow : 0);

export function layoutGoals(input: GoalsInput): GoalsLayout {
  const { goals, changeGoal } = goalsPlan(input);
  const S = GOALS_SIZES;
  const nodes: GoalsNode[] = [];
  const edges: GoalsEdge[] = [];
  const kids = new Map<string | null, PlanGoal[]>();
  for (const g of goals) kids.set(g.parentId, [...(kids.get(g.parentId) ?? []), g]);

  const drawnProjects = new Set<string>();
  nodes.push({ id: COMPANY_NODE_ID, kind: "company", x: 0, y: 0, ...S.company, name: input.tree.workspace.name || (input.tree.workspace.kind === "user" ? "Personal" : "Company"), goals: goals.length, projects: 0 });
  let y = S.company.h;
  const spine = (source: string, target: string, ghost: boolean) => edges.push({ id: `s:${source}->${target}`, source, target, kind: "spine", ...(ghost ? { ghost: true } : {}) });
  const owned: { node: string; owner: GoalOwner; ghost?: boolean; faded?: boolean }[] = [];
  const seen = new Set<string>();

  const place = (g: PlanGoal, parentNode: string, depth: number) => {
    if (seen.has(g.id)) return; // a cycle in parents: draw the goal once
    seen.add(g.id);
    const id = goalNodeId(g.id);
    const metric = g.row ? metricReadings(g.row)[0] ?? null : null;
    y += depth === 1 ? S.blockGap : S.rowGap;
    const h = goalHeight(g, metric);
    nodes.push({ id, kind: "goal", x: depth * S.indent, y, w: S.goal.w, h, goal: g, metric });
    spine(parentNode, id, !!g.ghost && !g.ghost.solid);
    y += h;
    if (g.owner) owned.push({ node: id, owner: g.owner, ghost: !!g.ownerGhost && !g.ownerGhost.solid });
    if (g.formerOwner) owned.push({ node: id, owner: g.formerOwner, faded: true });
    for (const p of g.projects) {
      const pid = projectNodeId(g.id, p.id);
      y += S.rowGap;
      nodes.push({ id: pid, kind: "project", x: (depth + 1) * S.indent, y, ...S.project, project: p });
      spine(id, pid, !!p.ghost && !p.ghost.solid);
      y += S.project.h;
      drawnProjects.add(p.id);
      if (p.lead) owned.push({ node: pid, owner: p.lead });
    }
    for (const k of kids.get(g.id) ?? []) place(k, id, depth + 1);
  };
  for (const g of kids.get(null) ?? []) place(g, COMPANY_NODE_ID, 1);
  (nodes[0] as Extract<GoalsNode, { kind: "company" }>).projects = drawnProjects.size;

  // The owners column: one card per owner, level with what it owns (the mean
  // of its rows), in that order, pushed down where two would overlap.
  const byNode = new Map(nodes.map((n) => [n.id, n]));
  const outlineRight = Math.max(...nodes.map((n) => n.x + n.w));
  const owners = new Map<string, { owner: GoalOwner; ys: number[]; owns: number }>();
  for (const o of owned) {
    const key = ownerNodeId(o.owner);
    const n = byNode.get(o.node)!;
    const e = owners.get(key) ?? { owner: o.owner, ys: [], owns: 0 };
    e.ys.push(n.y + n.h / 2);
    if (!o.faded) e.owns += 1;
    owners.set(key, e);
    edges.push({ id: `o:${o.node}->${key}${o.faded ? ":was" : ""}`, source: o.node, target: key, kind: "owner", ...(o.ghost ? { ghost: true } : {}), ...(o.faded ? { faded: true } : {}) });
  }
  const ox = outlineRight + S.ownerGap;
  let floor = 0;
  const column = [...owners.entries()].map(([id, e]) => ({ id, ...e, at: e.ys.reduce((a, b) => a + b, 0) / e.ys.length })).sort((a, b) => a.at - b.at);
  for (const o of column) {
    const oy = Math.max(floor, o.at - S.owner.h / 2);
    nodes.push({ id: o.id, kind: "owner", x: ox, y: oy, ...S.owner, owner: o.owner, owns: o.owns });
    floor = oy + S.owner.h + S.ownerRowGap;
  }

  const changeNode: Record<string, string> = {};
  for (const [changeId, goalId] of Object.entries(changeGoal)) changeNode[changeId] = goalNodeId(goalId);
  return {
    nodes, edges, changeNode, ownerLane: outlineRight + S.ownerLead,
    width: column.length ? ox + S.owner.w : outlineRight,
    height: Math.max(y, floor - S.ownerRowGap),
  };
}

/** Whether a proposal changes the goals: the lens the chart opens in for it. */
export const hasGoalChanges = (changes: readonly OrgProposalChange[] | undefined): boolean =>
  !!changes?.some((c) => GOAL_KINDS.has(c.change.kind) && c.status !== "removed");
