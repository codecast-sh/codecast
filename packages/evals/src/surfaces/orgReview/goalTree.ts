import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The goal tree a review proposes, graded against a snapshot's hand label
// (EVALS_HOME/labels/org-review/<ws>/goal-tree/<snapshot>.json): every goal a
// person stated takes its place under the right parent, nothing is invented,
// the tree has two levels, no number is made up, and every piece of live work
// the label lists reaches a goal it may serve. The goal tree read the
// founders asked for (ct-56727, ct-95902) is otherwise judged by eye.

export interface GoalTreeLabel {
  /** The goals people stated. `match` holds phrases one of which a goal's title carries (any case); `existing` is its in-N when the workspace already holds it; `parent` another label goal's id, absent for the mission or a top level goal; `number` true when a person named a number for it, so a target is theirs to carry; `optional` when a goal of its own is one right reading and placing its work under another goal is the other, so its absence is no miss. */
  goals: Array<{ id: string; match: string[]; existing?: string; parent?: string; number?: boolean; optional?: boolean }>;
  /** Live work (a plan's pl-N, a project's short id or title) and the label goals it may reach; ["any"] takes any goal. */
  place: Record<string, string[]>;
}

export interface GoalTreeGrade {
  found: string[];
  /** The goals the tree must hold: every label goal but the optional ones. */
  expected: number;
  missing: string[];
  parents: { right: string[]; wrong: string[] };
  invented: string[];
  third_level: string[];
  self_made_targets: string[];
  placed: { right: string[]; wrong: string[]; missed: string[] };
}

export function loadGoalTreeLabel(labelsDir: string, snapshot: string): GoalTreeLabel | null {
  const path = join(labelsDir, 'goal-tree', `${snapshot}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as GoalTreeLabel) : null;
}

type Node = { key: string; title: string; parent: string | null; projects: Set<string>; metricsAdded: boolean; isNew: boolean };
const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** The tree after the proposal: the inputs' open goals, then each goal change applied in order. */
export function treeAfter(changes: any[], inputs: any): Node[] {
  const projectKey = new Map<string, string>();
  for (const p of inputs.projects ?? []) {
    const key = norm(p.short_id ?? p.title);
    for (const ref of [p.id, p.short_id, p.title]) if (ref) projectKey.set(norm(ref), key);
  }
  const proj = (ref: unknown) => projectKey.get(norm(ref)) ?? norm(ref);
  const nodes: Node[] = (inputs.coverage?.initiatives ?? []).map((i: any) => ({ key: norm(i.short_id), title: i.title, parent: i.parent ? norm(i.parent) : null, projects: new Set((i.projects ?? []).map((p: any) => proj(p.short_id ?? p.title))), metricsAdded: false, isNew: false }));
  const find = (ref: unknown) => nodes.find((n) => n.key === norm(ref) || norm(n.title) === norm(ref));
  const parentKey = (ref: unknown) => (ref == null ? null : (find(ref)?.key ?? norm(ref)));
  for (const row of changes) {
    const c = row?.change ?? {};
    if (c.kind === 'initiative') {
      nodes.push({ key: norm(c.title), title: c.title, parent: parentKey(c.parent), projects: new Set((c.projects ?? []).map(proj)), metricsAdded: !!c.metrics?.length, isNew: true });
    } else if (c.kind === 'initiative_projects') {
      const n = find(c.initiative);
      if (n) for (const p of c.projects ?? []) n.projects.add(proj(p));
    } else if (c.kind === 'initiative_shape') {
      const n = find(c.initiative);
      if (!n) continue;
      if ('parent' in c) n.parent = parentKey(c.parent);
      if (c.metrics?.length) n.metricsAdded = true;
    }
  }
  return nodes;
}

/** Where a piece of work lands after the proposal: its project, filed or created there. */
function projectOfWork(ref: string, changes: any[], inputs: any): string {
  const filed = changes.map((r) => r?.change).filter((c) => c?.kind === 'file' && norm(c.plan) === norm(ref));
  if (filed.length) {
    const to = filed.at(-1).project;
    const p = (inputs.projects ?? []).find((x: any) => [x.id, x.short_id, x.title].some((v) => v && norm(v) === norm(to)));
    return norm(p ? (p.short_id ?? p.title) : to);
  }
  const p = (inputs.projects ?? []).find((x: any) => [x.id, x.short_id, x.title].some((v) => v && norm(v) === norm(ref)));
  return norm(p ? (p.short_id ?? p.title) : ref);
}

export function gradeGoalTree(changes: any[], inputs: any, label: GoalTreeLabel): GoalTreeGrade {
  const nodes = treeAfter(changes, inputs);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const nodeOf = new Map<string, Node>();
  for (const g of label.goals) {
    const n = (g.existing && byKey.get(norm(g.existing))) || nodes.find((x) => g.match.some((m) => norm(x.title).includes(norm(m))));
    if (n) nodeOf.set(g.id, n);
  }
  const labelOf = new Map<Node, (typeof label.goals)[number]>();
  for (const g of label.goals) { const n = nodeOf.get(g.id); if (n && !labelOf.has(n)) labelOf.set(n, g); }
  const parents = { right: [] as string[], wrong: [] as string[] };
  for (const g of label.goals) {
    const n = nodeOf.get(g.id);
    if (!n || !g.parent) continue;
    const want = nodeOf.get(g.parent);
    (want && n.parent === want.key ? parents.right : parents.wrong).push(g.id);
  }
  const depth = (n: Node, seen = new Set<Node>()): number => {
    const p = n.parent ? byKey.get(n.parent) : undefined;
    if (!p || seen.has(p)) return 0;
    seen.add(n);
    return 1 + depth(p, seen);
  };
  const placed = { right: [] as string[], wrong: [] as string[], missed: [] as string[] };
  for (const [work, ok] of Object.entries(label.place)) {
    const project = projectOfWork(work, changes, inputs);
    const reached = nodes.filter((n) => n.projects.has(project));
    if (!reached.length) { placed.missed.push(work); continue; }
    const fits = ok.includes('any') || reached.some((n) => ok.some((id) => nodeOf.get(id) === n));
    (fits ? placed.right : placed.wrong).push(`${work} under ${reached.map((n) => n.title).join(', ')}`);
  }
  return {
    found: label.goals.filter((g) => nodeOf.has(g.id)).map((g) => g.id),
    expected: label.goals.filter((g) => !g.optional).length,
    missing: label.goals.filter((g) => !nodeOf.has(g.id) && !g.optional).map((g) => g.id),
    parents,
    invented: nodes.filter((n) => n.isNew && !labelOf.has(n)).map((n) => n.title),
    third_level: nodes.filter((n) => depth(n) >= 2).map((n) => n.title),
    self_made_targets: nodes.filter((n) => n.metricsAdded && !labelOf.get(n)?.number).map((n) => n.title),
    placed,
  };
}
