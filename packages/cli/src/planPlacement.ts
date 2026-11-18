// Where a new plan or project fits in the goal tree. `cast plan create` with
// no --project and `cast project create` print the workspace's open goals with
// the projects that carry them, so the agent filing the work can place it
// under the goal it serves (or see that none fits). Pure: index.ts fetches.

type Palette = { cyan: string; dim: string; bold: string; yellow: string; reset: string };
type Goal = { short_id: string; title: string; status: string; project_ids?: string[]; projects?: Array<{ _id: string; title: string; short_id?: string }> };
type Project = { _id: string; title: string; short_id?: string; status?: string };

const OPEN_GOAL = new Set(["proposed", "planned", "active"]);
const MAX_GOALS = 12;
const MAX_LOOSE = 8;

export const openGoals = (goals: Goal[]): Goal[] =>
  goals.filter((g) => OPEN_GOAL.has(g.status)).sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1));

/** Projects by title: a title substring is a valid --project ref. */
const titles = (c: Palette, ps: Array<{ title: string }>) => ps.map((p) => p.title).join(`${c.dim}, ${c.reset}`);

/** Each open goal with the projects that carry it, then the live projects no open goal carries. */
export function goalTreeLines(c: Palette, goals: Goal[], projects: Project[]): string[] {
  const live = projects.filter((p) => p.status !== "done");
  const byId = new Map(live.map((p) => [String(p._id), p]));
  const open = openGoals(goals);
  const carried = new Set<string>();
  const lines: string[] = [];
  for (const [i, g] of open.entries()) {
    const ps = g.projects ?? ((g.project_ids ?? []).map((id) => byId.get(String(id))).filter(Boolean) as Project[]);
    for (const p of ps) carried.add(String(p._id));
    if (i < MAX_GOALS) lines.push(`    ${c.cyan}${g.short_id}${c.reset} ${c.bold}${g.title}${c.reset}  ${ps.length ? `${c.dim}in${c.reset} ${titles(c, ps)}` : `${c.yellow}no project yet${c.reset}`}`);
  }
  if (open.length > MAX_GOALS) lines.push(`    ${c.dim}+${open.length - MAX_GOALS} more goals: cast goal ls${c.reset}`);
  const loose = live.filter((p) => !carried.has(String(p._id)));
  if (loose.length) {
    const more = loose.length > MAX_LOOSE ? ` ${c.dim}+${loose.length - MAX_LOOSE} more${c.reset}` : "";
    lines.push(`    ${c.yellow}no goal${c.reset}  ${titles(c, loose.slice(0, MAX_LOOSE))}${more}`);
  }
  return lines;
}

/** After `cast plan create` with no --project: the plan is unplaced until filed. */
export function unplacedPlanLines(c: Palette, planRef: string, goals: Goal[], projects: Project[]): string[] {
  const head = `  ${c.yellow}unplaced${c.reset} ${planRef} is in no project, so no goal counts its work`;
  if (!projects.length) return [`${head}, and this workspace has no projects yet.`];
  return [`${head}. File it under the project whose goal it serves:`, `    cast plan update ${planRef} --project <ref>`, "", ...goalTreeLines(c, goals, projects)];
}

/** After `cast project create`: which open goal it serves. */
export function newProjectGoalLines(c: Palette, projectRef: string, goals: Goal[]): string[] {
  const open = openGoals(goals);
  if (!open.length) return [];
  const lines = [`  ${c.yellow}no goal${c.reset} Add it to the goal it serves:  cast goal add-project <in-N> ${projectRef}`];
  for (const g of open.slice(0, MAX_GOALS)) lines.push(`    ${c.cyan}${g.short_id}${c.reset} ${c.bold}${g.title}${c.reset}`);
  if (open.length > MAX_GOALS) lines.push(`    ${c.dim}+${open.length - MAX_GOALS} more: cast goal ls${c.reset}`);
  return lines;
}
