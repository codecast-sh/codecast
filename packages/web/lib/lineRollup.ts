// The roll-up: every line with anything on it, one row per project, counted
// the way the project's own line counts it (lineFlow buildLineFlow). It reads
// every row the floor holds, so it is written in steps (lib/slicedWork): the
// line app reads it in slices, a settings page all at once.
import { buildLineFlow, causesNeverRun, isBuiltInSource, isCause, projectKey, projectKeysOf, unapprovedShips, waitingCauseIds, waitingReadiness, NO_PROJECT, NO_PROJECT_ADMISSION, type LineAdmission, type LineDecision, type LineProject, type LineRows, type RollupRow } from "./lineFlow";
import { projectGraphs } from "./line/lineGraphs";
import { drain, type Sliced } from "./slicedWork";

/** Each project's roll-up row as the last roll-up read it, with every input it read. */
type RollupRead = { deps: unknown[]; row: RollupRow };
let rollupReads = new Map<string, RollupRead>();

/** Every project's rows at once, by the rules scopeLine applies to one: one pass over the rows, not one per project. */
function groupLine<D extends LineDecision>(rows: LineRows<D>, taskKey: ReadonlyMap<string, string>): Map<string, LineRows<D>> {
  const by = new Map<string, LineRows<D>>();
  const at = (key: string) => { let g = by.get(key); if (!g) by.set(key, (g = { tasks: [], signals: [], runs: [], decisions: [] })); return g; };
  for (const t of rows.tasks) at(projectKey(t.project_id)).tasks.push(t);
  for (const s of rows.signals) at(s.project_id ? s.project_id : taskKey.get(s.task_id) ?? NO_PROJECT).signals.push(s);
  for (const r of rows.runs) { const k = r.task_id ? taskKey.get(r.task_id) : undefined; if (k) at(k).runs.push(r); }
  for (const d of rows.decisions) { const k = d.task_id ? taskKey.get(d.task_id) : undefined; if (k) at(k).decisions.push(d); }
  return by;
}

/**
 * Every line with anything on it, counted the way its own page counts:
 * projects holding a cause or a signal in the window, projects whose profile
 * declares finders, and the work filed under no project. Most open causes first.
 */
export function lineRollup<D extends LineDecision>(rows: LineRows<D>, projects: LineProject[], now: number, cardsCap?: number, admissions?: ReadonlyMap<string, LineAdmission>): RollupRow[] {
  return drain(lineRollupSteps(rows, projects, now, cardsCap, admissions));
}

/** lineRollup, stopping between projects (lib/slicedWork). */
export function* lineRollupSteps<D extends LineDecision>(rows: LineRows<D>, projects: LineProject[], now: number, cardsCap?: number, admissions?: ReadonlyMap<string, LineAdmission>): Sliced<RollupRow[]> {
  const keys = new Set<string>();
  for (const t of rows.tasks) if (isCause(t)) keys.add(projectKey(t.project_id));
  const causeKey = projectKeysOf(rows.tasks);
  for (const s of rows.signals) keys.add(s.project_id || causeKey.get(s.task_id) || NO_PROJECT);
  for (const p of projects) if (p.line_profile) keys.add(p._id);
  const byId = new Map(projects.map((p) => [p._id, p]));
  const grouped = groupLine(rows, causeKey);
  const out: RollupRow[] = [];
  const kept = new Map<string, RollupRead>();
  yield;
  for (const key of keys) {
    yield;
    const project = byId.get(key);
    // A project the viewer cannot see (another workspace's) is not a line here.
    if (key !== NO_PROJECT && !project) continue;
    const scoped = { ...rows, ...(grouped.get(key) ?? { tasks: [], signals: [], runs: [], decisions: [] }) };
    const admission = key === NO_PROJECT ? NO_PROJECT_ADMISSION : admissions?.get(key);
    // A push moves a few projects' rows: a project whose rows, clock and settings are the ones its last row read keeps it.
    const deps: unknown[] = [now, cardsCap, project, admission, scoped.tasks.length, ...scoped.tasks, "|", ...scoped.signals, "|", ...scoped.runs, "|", ...scoped.decisions];
    const was = rollupReads.get(key);
    if (was && was.deps.length === deps.length && was.deps.every((d, n) => d === deps[n])) { kept.set(key, was); out.push(was.row); continue; }
    const f = buildLineFlow({ ...scoped, initiatives: [], projects: [], now, cardsCap, finders: project?.line_profile?.finders, findersSince: project?.line_profile?.changed_at, admission });
    const row: RollupRow = {
      key,
      title: project?.title ?? "No project",
      short_id: project?.short_id,
      signalsDay: f.sense.count,
      causes: f.causes.count,
      build: f.build.count,
      awaiting: f.awaiting.count,
      watching: f.watching.count,
      closed: f.closed.count,
      finders: project?.line_profile?.finders.length ?? 0,
      silent: f.sense.items.filter((s) => s.silent).length,
      undeclared: f.sense.items.filter((s) => !s.finder && s.week > 0 && !isBuiltInSource(s.source)).sort((a, b) => b.week - a.week).map((s) => s.source),
      hold: f.causes.count > 0 && f.causes.state.kind === "paused" ? f.causes.state.why : null,
      stalled: f.build.items.filter((b) => b.stalled).length,
      failing: f.build.state.kind === "failing",
      graphs: projectGraphs(scoped.runs, scoped.signals, undefined, waitingCauseIds(f)),
      neverRun: causesNeverRun(f, scoped.runs),
      unapproved: unapprovedShips(scoped.tasks.filter(isCause), scoped.runs, now).length,
      ...waitingReadiness([...f.causes.items, ...f.causes.parked].map((r) => r.task)),
      startingOff: f.causes.count > 0 && f.causes.state.kind === "paused" && !!admission?.role && !admission.role.paused && !admission.on,
    };
    kept.set(key, { deps, row });
    out.push(row);
  }
  rollupReads = kept;
  return out.sort((a, b) => Number(a.key === NO_PROJECT) - Number(b.key === NO_PROJECT) || b.causes - a.causes || b.awaiting - a.awaiting || b.signalsDay - a.signalsDay || a.title.localeCompare(b.title));
}
