// A `cast task ls` / `ready` / `overview` row as the server judged it:
// tasks.list attaches `ready` and `open_blockers` (labels from blockersOf,
// task-graph.md TG1), so a row whose blockers finished is not tagged blocked.
// A row from a server older than that carries neither, and its raw
// `blocked_by` is the best it can say.

type ListedTask = { status?: string; blocked_by?: string[] | null; open_blockers?: string[]; ready?: boolean };

/** What still holds the task back, one label each ("ct-12", "PR #42 merged"). */
export function listedBlockers(t: ListedTask): string[] {
  return t.open_blockers ?? t.blocked_by ?? [];
}

/** Whether `cast task ready` would list it. */
export function listedReady(t: ListedTask): boolean {
  return t.ready ?? (t.status === "open" && listedBlockers(t).length === 0);
}
