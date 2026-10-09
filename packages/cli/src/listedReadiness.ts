// A `cast task ls` / `ready` / `overview` row as the server judged it:
// tasks.list attaches `ready` and `open_blockers` (blockersHoldingBack's entries,
// task-graph.md TG1), so a row whose blockers finished is not tagged blocked.
// The labels are written here, so a time wait reads in this machine's zone.
// A row from a server older than that carries neither, and its raw
// `blocked_by` is the best it can say.

import { blockerLabel, type Blocker, type ChecksOption, type WaitLabelOptions } from "@codecast/shared/tasks";

/** An entry of `open_blockers`: a still-waiting checks wait carries its PR's
 *  `checks_state` (the server stamps it, convex/taskLinks.ts), since these are
 *  the lists with no bracket to hold a state. */
type ListedBlocker = Blocker & ChecksOption;

type ListedTask = { status?: string; blocked_by?: string[] | null; open_blockers?: (ListedBlocker | string)[]; ready?: boolean };

/** The structured entries of `open_blockers`, for a caller that needs the
 *  blockers themselves (the parking line, which reads a wait's kind, state and
 *  checks) rather than their labels. A string entry is a label from a server
 *  that labelled in UTC itself, so it carries no fields to read and is dropped. */
export function listedBlockerEntries(t: ListedTask): ListedBlocker[] {
  return (t.open_blockers ?? []).filter((b): b is ListedBlocker => typeof b === "object" && b !== null);
}

/** What still holds the task back, one label each ("ct-12", "PR #42 to merge").
 *  `words` names PRs as the checkout reads them (checkoutWords). A checks wait
 *  reads by its own PR's checks ("PR #42 checks failing"), because these lines
 *  carry no state bracket and are the ones that tell an agent to park: red
 *  checks keep the wait waiting and only a new push turns them green (TG2). */
export function listedBlockers(t: ListedTask, words: WaitLabelOptions = {}): string[] {
  // A string entry is a label from a server that labelled in UTC itself.
  return t.open_blockers?.map((b) => typeof b === "string" ? b : blockerLabel(b, { ...words, checks: b.checks })) ?? t.blocked_by ?? [];
}

/** Whether `cast task ready` would list it. */
export function listedReady(t: ListedTask): boolean {
  return t.ready ?? (t.status === "open" && listedBlockers(t).length === 0);
}
