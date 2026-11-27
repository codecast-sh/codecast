import type { PriorityChangeKind } from "@codecast/shared/contracts/priorityCard";
import type { MarkDef } from "./types";

// The priorities pass's change icons, one per kind on its decision card
// (components/decisions/PriorityChangeCard.tsx). A priority's and a
// milestone's rename or reopen share one glyph and one meaning, so one mark.
const mark = (id: string, name: string, meaning: string): MarkDef => ({ id: `change.${id}`, name, meaning, group: "Priorities pass" });

export const changeMarks: MarkDef[] = [
  mark("move_up", "Moved up", "The priority moves higher in your list"),
  mark("move_down", "Moved down", "The priority moves lower in your list"),
  mark("rename", "Rename", "A new name for a priority or milestone"),
  mark("new_priority", "New priority", "A priority added to your list"),
  mark("done", "Priority done", "The priority is finished"),
  mark("reopen", "Reopened", "A finished priority or milestone opens again"),
  mark("serves", "Serves another goal", "The priority counts toward a different goal"),
  mark("merge", "Merged", "Another priority folds into this one"),
  mark("new_milestone", "New milestone", "A milestone added to the priority"),
  mark("milestone_done", "Milestone done", "The milestone landed"),
  mark("to_critical", "Moved to critical", "The milestone joins the priority's critical path"),
  mark("to_polish", "Moved to polish", "The milestone leaves the critical path"),
  mark("drop_milestone", "Dropped", "The milestone comes off the priority"),
];

/** The mark a change row draws: a move by the way it goes, the milestone twins under the priority's mark. */
export function changeMarkId(kind: PriorityChangeKind, down: boolean): string {
  if (kind === "move") return down ? "change.move_down" : "change.move_up";
  if (kind === "rename_milestone") return "change.rename";
  if (kind === "milestone_reopen") return "change.reopen";
  return `change.${kind}`;
}
