// A `cast task ls` / `ready` / `overview` row as the server judged it:
// tasks.list attaches `ready` and `open_blockers` (blockersHoldingBack's entries,
// task-graph.md TG1), so a row whose blockers finished is not tagged blocked.
// The labels are written here, so a time wait reads in this machine's zone.
// A row from a server older than that carries neither, and its raw
// `blocked_by` is the best it can say.

import { blockerLabel, type Blocker, type WaitLabelOptions } from "@codecast/shared/tasks";

type ListedTask = { status?: string; blocked_by?: string[] | null; open_blockers?: (Blocker | string)[]; ready?: boolean };

/** What still holds the task back, one label each ("ct-12", "PR #42 merges").
 *  `words` names PRs as the checkout reads them (checkoutWords). */
export function listedBlockers(t: ListedTask, words: WaitLabelOptions = {}): string[] {
  // A string entry is a label from a server that labelled in UTC itself.
  return t.open_blockers?.map((b) => typeof b === "string" ? b : blockerLabel(b, words)) ?? t.blocked_by ?? [];
}

/** Whether `cast task ready` would list it. */
export function listedReady(t: ListedTask): boolean {
  return t.ready ?? (t.status === "open" && listedBlockers(t).length === 0);
}
