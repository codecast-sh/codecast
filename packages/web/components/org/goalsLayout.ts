// The Goals lens of the org chart (docs/architecture/org-staffing.md S36).
// Pure: the org tree, the workspace's initiatives and projects and the open
// proposal's changes in, positioned nodes and edges out.
//
// Shape: an outline on the left (the company, its top level goals, the goals
// that feed them, the projects that carry each) and a column of owners on the
// right, one card per person or role. An owner edge exists for every goal and
// led project, but the canvas draws only the edges of the card under the
// pointer or selected (OrgGraph.goalsFlowEdges): each goal already wears its
// owner's face, so the resting picture has no line crossing it. A project
// carried by several goals is drawn once, under the goal nearest the work,
// and is a reference chip on the others.
//
// The outline is drawn AS IT WILL BE once the open proposal is accepted, each
// changed thing in ghost chrome. What a goal change names (its goal, parent,
// owner, former parent) is read off `proposalChangeRows`, the rows the
// proposal card joins and nests, so the chart and the card cannot disagree.
import type { InitiativeOwner, InitiativeRow } from "@codecast/shared/contracts/initiative";
import { metricReadings, nextMilestone, type MetricReading } from "@codecast/shared/contracts/initiative";
import { editedOrgChange, ORG_GOAL_KINDS, type OrgChangeKind } from "@codecast/shared/contracts/orgProposal";
import { projectLeadOf } from "@codecast/shared/contracts/orgLead";
import { byListOrder } from "../../lib/initiatives";
import type { OrgSession, OrgTree } from "./orgTypes";
import type { OrgProposalChange } from "./orgStaffingTypes";
import { ghostScopeNames, ORG_SIZES, personNodeId, roleNodeId, type OrgGhostChip, type OrgGhostMeta } from "./orgLayout";
import { proposalChangeRows, type ProposalTreeFace, type ProposalTreeRow } from "./proposalTree";

/** What the lens reads off a project row. */
export type GoalProject = { _id: string; title: string; short_id?: string; status?: string; owner_role_id?: string };

/** A change as a goal or project card wears it: the tag it leads with, and
 *  whether it is accepted (drawn solid until the store carries it). */
export type GoalGhost = OrgGhostMeta & { kind: OrgChangeKind; tag: string | null; solid: boolean; unresolved?: boolean };

/** Who owns a goal or leads a project: a person, a role (live, or one this
 *  proposal creates), or a name nothing in the workspace answers to. */
export type GoalOwner = Extract<ProposalTreeFace, { kind: "person" | "role" | "unknown" }>;

export type GoalsInput = {
  tree: OrgTree;
  initiatives: readonly InitiativeRow[];
  projects: readonly GoalProject[];
  /** The open proposal's changes; absent, the lens draws what is. */
  changes?: readonly OrgProposalChange[];
  /** The change in focus: its card keeps a row free beneath it for the action strip. */
  focusChangeId?: string | null;
};

// ---------------------------------------------------------------- the plan

export type PlanProject = { id: string; title: string; short_id?: string; status?: string; lead: GoalOwner | null; ghost?: GoalGhost };
export type PlanGoal = {
  id: string;
  title: string;
  short_id?: string;
  /** The live row; absent on a goal this proposal sets. */
  row?: InitiativeRow;
  /** What the goal means, in its owner's words (the close card reads it). */
  description?: string;
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
  /** Where the goal sits among its siblings: live goals in list order, then
   *  what the proposal sets or moves in the proposal's order, as the card reads. */
  order: number;
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
    // A lead the project names or whose scope lists it. The whole workspace
    // fallback (a head of people with no scope) covers every project by the
    // rule, and an edge from each project to it would say nothing.
    return lead?.kind === "lead" && lead.by !== "workspace" ? { kind: "role", id: lead.role._id, name: lead.role.name, handle: lead.role.handle, avatar: lead.role.avatar } : null;
  };
  const carried = (refs: readonly string[], ghost?: GoalGhost): PlanProject[] =>
    ghostScopeNames({ projects: refs }, tree, { projects: projectRows }).projects.map((p) => ({ id: p.id, title: p.title, short_id: p.short_id, status: projectById.get(p.id)?.status, lead: leadOf(p.id), ...(ghost ? { ghost } : {}) }));

  const goals: PlanGoal[] = [...initiatives]
    .filter((g) => g.status !== "cancelled" && g.status !== "completed")
    .sort(byListOrder)
    .map((g, i) => ({ id: g._id, title: g.title, short_id: g.short_id, row: g, description: g.description, parentId: g.parent_initiative_id ?? null, owner: liveOwner(tree, g.owner), projects: carried(g.project_ids), chips: [], order: i }));
  const byId = new Map(goals.map((g) => [g.id, g]));
  const changeGoal: Record<string, string> = {};

  const changeById = new Map(changes.map((c) => [c._id, c]));
  const PROPOSED = 1_000_000;
  const seqOf = (r: ProposalTreeRow) => PROPOSED + (changeById.get(r.change_id)?.seq ?? 0);
  const rows = proposalChangeRows(tree, changes, { goals: initiatives, projects: projectRows }).filter((r) => GOAL_KINDS.has(r.kind) && DRAWN.has(r.status));
  // A row's `unresolved` is about its owner (proposalTree), so only an owner edge wears it.
  const metaOf = (r: ProposalTreeRow, tag: string | null, owner = false): GoalGhost => ({ change_id: r.change_id, status: r.status, line: r.line, kind: r.kind, tag, solid: r.status === "accepted", ...(owner && r.unresolved ? { unresolved: true } : {}) });
  const chipOf = (r: ProposalTreeRow, chip: string): OrgGhostChip => ({ change_id: r.change_id, status: r.status, line: r.line, kind: r.kind, chip, ...(r.unresolved ? { unresolved: true } : {}) });
  // A goal a change names that nothing live or proposed answers to is still
  // a change the person can decide: it is drawn, at the top, as a warning.
  const goalFor = (r: ProposalTreeRow): PlanGoal => {
    const known = byId.get(r.node.id);
    if (known) return known;
    const g: PlanGoal = { id: r.node.id, title: r.node.name, parentId: null, owner: null, projects: [], chips: [], ghost: { ...metaOf(r, "unknown"), unresolved: true }, order: seqOf(r) };
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
          id: r.node.id, title: r.node.name, description: ch.description, parentId: r.parent?.id ?? null, owner,
          projects: carried(ch.projects, { ...ghost, tag: null }), ghost,
          chips: ch.metrics?.length ? [chipOf(r, ch.metrics.map((m) => `${m.name.trim()} \u2192 ${m.target.trim()}`).join(", "))] : [],
          ...(owner ? { ownerGhost: metaOf(r, r.tag, true) } : {}),
          order: seqOf(r),
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
          g.order = seqOf(r);
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

// Every size here is a card at the MIDDLE zoom level. A node's box (`h`) is its
// close level size, which the layout reserves so zooming never moves a card
// (orgZoom); `mid` is the height the middle card takes inside that box.
export const GOALS_SIZES = {
  company: { w: 264, h: 56 },
  goal: { w: 312, h: 58 },
  /** A goal's title is a sentence, wrapped by word: this many characters fit
   *  a line of the middle card (13px in 234px), and it takes up to three. */
  titleChars: 29,
  titleRow: 16,
  /** The far card's title (21px in 265px, 25px lines) and its padding: the
   *  box is never shorter than the far card needs. */
  farChars: 20,
  farRow: 25,
  farPad: 18,
  project: { w: 260, h: 34 },
  owner: { w: 216, h: 46 },
  /** Close level extras: the rule under a goal's header, its description
   *  (two lines), its next milestone, its latest update and its running
   *  sessions (one line each), a project's number, status and lead line, a
   *  role owner's standing line. */
  closeRule: 9,
  descRow: 36,
  milestoneRow: 17,
  updateRow: 17,
  runningRow: 17,
  projectClose: 16,
  ownerClose: 18,
  /** Where an edge meets a card, from its top: inside every level's card. */
  anchor: { company: 28, goal: 24, project: 17, owner: 23 },
  /** A card's indent under its parent, and the spine's own inset from the parent's left edge. */
  indent: 30,
  spineInset: 15,
  rowGap: 8,
  /** The gap above a top level goal: each is its own block. */
  blockGap: 22,
  /** Extra goal height: a metric read against its target, a line per change
   *  on the goal (its metrics, its owner), the "was under" line, the row of
   *  projects it carries that are drawn under another goal. */
  metricRow: 18,
  chipRow: ORG_SIZES.quietChipRow,
  wasRow: 16,
  refRow: 22,
  /** The room a focused ghost keeps beneath it for its Accept, Edit, Skip strip. */
  actionRow: 34,
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

/** `h` is the close level box the layout reserves; `mid` the middle card's height inside it. */
type Box = { id: string; x: number; y: number; w: number; h: number; mid: number };
export type GoalsNode =
  | (Box & { kind: "company"; name: string; goals: number; projects: number })
  | (Box & {
      kind: "goal";
      goal: PlanGoal;
      /** Every metric read against its target; the middle card shows the first. */
      metrics: MetricReading[];
      /** The projects drawn as rows under this goal (projectRows). */
      rows: PlanProject[];
      /** Projects the goal carries that are drawn under another goal: a chip each, naming where. */
      refs: { project: PlanProject; under: string }[];
      /** Sessions working now under a role whose area holds one of the goal's projects, for the close card. */
      running: OrgSession[];
    })
  | (Box & { kind: "project"; project: PlanProject })
  | (Box & { kind: "owner"; owner: GoalOwner; owns: number; /** A role's standing line, for the close card. */ line?: string });

/** Where an edge meets a node, from the node's top. */
export const goalsAnchor = (n: Pick<GoalsNode, "kind">): number => GOALS_SIZES.anchor[n.kind];

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

/** How many lines a title takes wrapped by word at `chars` a line, one to three (the cards clamp at three). */
export function wrappedLines(title: string, chars: number): number {
  let lines = 1, used = 0;
  for (const word of title.trim().split(/\s+/)) {
    const need = used ? used + 1 + word.length : word.length;
    if (used && need > chars) { lines += 1; used = word.length; } else used = need;
    // A word longer than a line breaks inside itself.
    while (used > chars) { lines += 1; used -= chars; }
  }
  return Math.min(3, lines);
}
export const titleLines = (title: string) => wrappedLines(title, GOALS_SIZES.titleChars);
/** The far card's height: its title alone. */
export const goalFarHeight = (title: string) => GOALS_SIZES.farPad + wrappedLines(title, GOALS_SIZES.farChars) * GOALS_SIZES.farRow;
const goalHeight = (g: PlanGoal, metric: boolean, refs: number) =>
  GOALS_SIZES.goal.h + (titleLines(g.title) - 1) * GOALS_SIZES.titleRow + (metric ? GOALS_SIZES.metricRow : 0) + g.chips.length * GOALS_SIZES.chipRow + (g.was ? GOALS_SIZES.wasRow : 0) + (refs ? GOALS_SIZES.refRow : 0);
/** What the close card adds under the middle one: the description, the
 *  metrics past the first, the latest update, the running sessions. */
const goalCloseExtra = (g: PlanGoal, metrics: number, running: number) => {
  const rows = (g.description?.trim() ? GOALS_SIZES.descRow : 0) + Math.max(0, metrics - 1) * GOALS_SIZES.metricRow + (g.row && nextMilestone(g.row) ? GOALS_SIZES.milestoneRow : 0) + (g.row && g.row.health !== "none" ? GOALS_SIZES.updateRow : 0) + (running ? GOALS_SIZES.runningRow : 0);
  return rows ? rows + GOALS_SIZES.closeRule : 0;
};

/** Sessions working now under a role whose area holds one of the projects, newest first, three at most. */
export const RUNNING_MAX = 3;
export function runningUnder(tree: OrgTree, projectIds: readonly string[]): OrgSession[] {
  if (projectIds.length === 0) return [];
  const ids = new Set(projectIds);
  return tree.roles
    .filter((r) => r.status !== "retired" && r.scope.project_ids.some((p) => ids.has(p)))
    .flatMap((r) => r.sessions.filter((x) => x.state === "working"))
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, RUNNING_MAX);
}

/**
 * Where each project is drawn, when several goals carry it: under the goal
 * nearest the work (the deepest); among those, under a goal that carries it
 * today before one a proposal would set; then under the one whose owner leads
 * the project; else the first in the outline. A purpose set over every
 * project would otherwise repeat the whole list above the goals that answer
 * for each. A row an `initiative_projects` change adds is that change's one
 * mark on the chart, so it is always a row and claims nothing.
 */
export function projectRows(goals: readonly { id: string; depth: number; goal: PlanGoal }[]): Map<string, { rows: PlanProject[]; refs: { project: PlanProject; under: string }[] }> {
  const leads = (g: PlanGoal, p: PlanProject) => !!g.owner && !!p.lead && g.owner.kind === "role" && p.lead.kind === "role" && g.owner.id === p.lead.id;
  /** Higher wins, compared in order; the outline's order breaks a full tie. */
  const rank = (depth: number, g: PlanGoal, p: PlanProject) => [depth, p.ghost ? 0 : 1, leads(g, p) ? 1 : 0];
  const primary = new Map<string, { id: string; rank: number[] }>();
  for (const { id, depth, goal } of goals) {
    for (const p of goal.projects) {
      if (p.ghost?.kind === "initiative_projects") continue;
      const r = rank(depth, goal, p);
      const cur = primary.get(p.id);
      const d = cur ? r.map((v, i) => v - cur.rank[i]).find((v) => v !== 0) ?? 0 : 1;
      if (d > 0) primary.set(p.id, { id, rank: r });
    }
  }
  const titleOf = new Map(goals.map((g) => [g.id, g.goal.title]));
  const out = new Map<string, { rows: PlanProject[]; refs: { project: PlanProject; under: string }[] }>();
  for (const { id, goal } of goals) {
    const rows: PlanProject[] = [], refs: { project: PlanProject; under: string }[] = [];
    for (const p of goal.projects) {
      const under = p.ghost?.kind === "initiative_projects" ? id : primary.get(p.id)?.id ?? id;
      if (under === id) rows.push(p); else refs.push({ project: p, under: titleOf.get(under) ?? "" });
    }
    out.set(id, { rows, refs });
  }
  return out;
}

export function layoutGoals(input: GoalsInput): GoalsLayout {
  const { goals, changeGoal } = goalsPlan(input);
  const S = GOALS_SIZES;
  const focus = input.focusChangeId ?? null;
  const nodes: GoalsNode[] = [];
  const edges: GoalsEdge[] = [];
  const kids = new Map<string | null, PlanGoal[]>();
  for (const g of goals) kids.set(g.parentId, [...(kids.get(g.parentId) ?? []), g]);
  for (const list of kids.values()) list.sort((a, b) => a.order - b.order);

  // The outline's order and depth first (a cycle in parents draws a goal once), then where each project lands.
  const outline: { id: string; depth: number; goal: PlanGoal; parentNode: string }[] = [];
  const seen = new Set<string>();
  const walk = (g: PlanGoal, parentNode: string, depth: number) => {
    if (seen.has(g.id)) return;
    seen.add(g.id);
    outline.push({ id: g.id, depth, goal: g, parentNode });
    for (const k of kids.get(g.id) ?? []) walk(k, goalNodeId(g.id), depth + 1);
  };
  for (const g of kids.get(null) ?? []) walk(g, COMPANY_NODE_ID, 1);
  const placed = projectRows(outline);

  const drawnProjects = new Set<string>();
  nodes.push({ id: COMPANY_NODE_ID, kind: "company", x: 0, y: 0, ...S.company, mid: S.company.h, name: input.tree.workspace.name || (input.tree.workspace.kind === "user" ? "Personal" : "Company"), goals: goals.length, projects: 0 });
  let y = S.company.h;
  const spine = (source: string, target: string, ghost: boolean) => edges.push({ id: `s:${source}->${target}`, source, target, kind: "spine", ...(ghost ? { ghost: true } : {}) });
  const owned: { node: string; owner: GoalOwner; ghost?: boolean; faded?: boolean }[] = [];

  for (const { id: goalId, depth, goal: g, parentNode } of outline) {
    const id = goalNodeId(goalId);
    const { rows, refs } = placed.get(goalId)!;
    const metrics = g.row ? metricReadings(g.row) : [];
    const running = runningUnder(input.tree, g.projects.map((p) => p.id));
    y += depth === 1 ? S.blockGap : S.rowGap;
    const mid = goalHeight(g, metrics.length > 0, refs.length);
    const h = Math.max(mid + goalCloseExtra(g, metrics.length, running.length), goalFarHeight(g.title));
    nodes.push({ id, kind: "goal", x: depth * S.indent, y, w: S.goal.w, h, mid, goal: g, metrics, rows, refs, running });
    spine(parentNode, id, !!g.ghost && !g.ghost.solid);
    y += h + (goalFocusedChange(focus, g.ghost, g.chips) ? S.actionRow : 0);
    if (g.owner) owned.push({ node: id, owner: g.owner, ghost: !!g.ownerGhost && !g.ownerGhost.solid });
    if (g.formerOwner) owned.push({ node: id, owner: g.formerOwner, faded: true });
    for (const p of rows) {
      const pid = projectNodeId(g.id, p.id);
      y += S.rowGap;
      nodes.push({ id: pid, kind: "project", x: (depth + 1) * S.indent, y, w: S.project.w, h: S.project.h + S.projectClose, mid: S.project.h, project: p });
      spine(id, pid, !!p.ghost && !p.ghost.solid);
      y += S.project.h + S.projectClose + (p.ghost?.kind === "initiative_projects" && goalFocusedChange(focus, p.ghost) ? S.actionRow : 0);
      drawnProjects.add(p.id);
      if (p.lead) owned.push({ node: pid, owner: p.lead });
    }
  }
  (nodes[0] as Extract<GoalsNode, { kind: "company" }>).projects = drawnProjects.size;

  // The owners column: one card per owner, level with the first thing it
  // owns (the purpose's owner sits beside the purpose, at the top), in that
  // order, pushed down where two would overlap.
  const byNode = new Map(nodes.map((n) => [n.id, n]));
  const outlineRight = Math.max(...nodes.map((n) => n.x + n.w));
  const owners = new Map<string, { owner: GoalOwner; ys: number[]; owns: number }>();
  for (const o of owned) {
    const key = ownerNodeId(o.owner);
    const n = byNode.get(o.node)!;
    const e = owners.get(key) ?? { owner: o.owner, ys: [], owns: 0 };
    e.ys.push(n.y + goalsAnchor(n));
    if (!o.faded) e.owns += 1;
    owners.set(key, e);
    edges.push({ id: `o:${o.node}->${key}${o.faded ? ":was" : ""}`, source: o.node, target: key, kind: "owner", ...(o.ghost ? { ghost: true } : {}), ...(o.faded ? { faded: true } : {}) });
  }
  const ox = outlineRight + S.ownerGap;
  let floor = 0;
  const column = [...owners.entries()].map(([id, e]) => ({ id, ...e, at: Math.min(...e.ys) })).sort((a, b) => a.at - b.at);
  for (const o of column) {
    const oy = Math.max(floor, o.at - S.anchor.owner);
    const line = o.owner.kind === "role" ? input.tree.roles.find((r) => r._id === o.owner.id)?.standing?.state_line?.trim() || undefined : undefined;
    const h = S.owner.h + (line ? S.ownerClose : 0);
    nodes.push({ id: o.id, kind: "owner", x: ox, y: oy, w: S.owner.w, h, mid: S.owner.h, owner: o.owner, owns: o.owns, ...(line ? { line } : {}) });
    floor = oy + h + S.ownerRowGap;
  }

  const changeNode: Record<string, string> = {};
  for (const [changeId, goalId] of Object.entries(changeGoal)) changeNode[changeId] = goalNodeId(goalId);
  return {
    nodes, edges, changeNode, ownerLane: outlineRight + S.ownerLead,
    width: column.length ? ox + S.owner.w : outlineRight,
    height: Math.max(y, floor - S.ownerRowGap),
  };
}

/** The change whose action strip a goal or project card shows: its own ghost
 *  or one of its chips, when the chart is focused on that change. Goal rows
 *  sit tight, so unlike a role stub the strip waits for the focus. */
export const goalFocusedChange = (focusChangeId: string | null | undefined, ghost: GoalGhost | undefined, chips: readonly OrgGhostChip[] = []): GoalGhost | OrgGhostChip | null =>
  !focusChangeId ? null : ghost?.change_id === focusChangeId ? ghost : chips.find((c) => c.change_id === focusChangeId) ?? null;

/** Whether a proposal changes the goals: the lens the chart opens in for it. */
export const hasGoalChanges = (changes: readonly OrgProposalChange[] | undefined): boolean =>
  !!changes?.some((c) => GOAL_KINDS.has(c.change.kind) && c.status !== "removed");
