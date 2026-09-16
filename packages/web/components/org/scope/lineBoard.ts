// Pure rules the scope page's Line tab paints from (docs/architecture/
// the-line.md L3, L10): the team's statuses are the stations and a task sits
// in the column of its status. The hold, the task's run, its live node and
// the hand's state are the task page's rules (lib/taskLine.ts); the board
// imports them so the two surfaces can never disagree. Kept out of the
// component so it tests without React.
import type { TeamTaskStatus } from "@codecast/shared/tasks";
import { stationOrder } from "../../../lib/taskLine";
import { taskStatusKey } from "../../../lib/taskStatuses";

export type LineTaskLike = {
  _id: string;
  status?: string | null;
  status_id?: string | null;
  workflow_run_id?: string;
  updated_at?: number;
  files_changed?: string[];
};

export type LineColumn<T extends LineTaskLike> = { status: TeamTaskStatus; tasks: T[] };

/** One column per station in pipeline order (backlog to dropped, the team's
 *  own order inside a category); a task lands in the column of the status it
 *  resolves to, newest change first. Every station is present, empty or not,
 *  so the board reads the same shape for every scope. */
export function lineColumns<T extends LineTaskLike>(tasks: T[], statuses: TeamTaskStatus[]): LineColumn<T>[] {
  const ordered = stationOrder(statuses);
  const byKey = new Map<string, T[]>(ordered.map((s) => [s.id, []]));
  for (const t of tasks) {
    const key = taskStatusKey(t, ordered);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(t);
    else byKey.get(ordered[0]?.id ?? "")?.push(t);
  }
  return ordered.map((status) => ({
    status,
    tasks: (byKey.get(status.id) ?? []).slice().sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)),
  }));
}

/** Evidence the card can count without a query: pages bound to the task in
 *  the artifacts store (rows that carry `task_id`) and the files its handoff
 *  named. */
export function evidenceCount(task: LineTaskLike, artifacts: Array<{ task_id?: string | null }>): { pages: number; files: number } {
  let pages = 0;
  for (const a of artifacts) if (a.task_id === task._id) pages++;
  return { pages, files: task.files_changed?.length ?? 0 };
}

// ---------------------------------------------------------------- the line picker (L2)

/** The workflow templates the CLI ships (packages/cli/src/workflow/templates.ts).
 *  The web has no copy of the sources; it needs only the names a role's line
 *  may resolve to when the host has pushed no workflow of that slug. */
export const SHIPPED_LINE_TEMPLATES: ReadonlyArray<{ slug: string; name: string }> = [
  { slug: "line", name: "line" },
  { slug: "feature", name: "feature" },
  { slug: "plan-autopilot", name: "plan-autopilot" },
];

export type LineOption = { slug: string; label: string; shipped: boolean };

/** The picker's rows: the shipped templates, then the caller's own workflows
 *  by slug (an own workflow with a shipped slug wins, since the sweep runs the
 *  pushed row first, L9). A current slug nothing lists stays selectable so
 *  the picker never shows a value it cannot name. */
export function lineOptions(workflows: Array<{ slug: string; name?: string }>, current: string): LineOption[] {
  const own = new Map<string, string>();
  for (const w of workflows) if (w.slug && !own.has(w.slug)) own.set(w.slug, w.name || w.slug);
  const out: LineOption[] = [];
  for (const t of SHIPPED_LINE_TEMPLATES) {
    const mine = own.get(t.slug);
    out.push({ slug: t.slug, label: mine ? `${mine} (yours)` : `${t.name} (shipped)`, shipped: !mine });
    own.delete(t.slug);
  }
  for (const [slug, name] of own) out.push({ slug, label: name === slug ? slug : `${name} (${slug})`, shipped: false });
  if (current && !out.some((o) => o.slug === current)) out.push({ slug: current, label: `${current} (not pushed)`, shipped: false });
  return out;
}
