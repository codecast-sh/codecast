// The one word a goal's state is said in, wherever it is said: its line in
// the document, its card on the map and the company's state line all read it
// here, so one goal never goes by two words on one screen. Pure, so the
// document's model can count by it without pulling in the line's cells.
import { INITIATIVE_HEALTH_LABEL, INITIATIVE_STATUS_LABEL, type InitiativeRow, type InitiativeStatus } from "@codecast/shared/contracts/initiative";

/** A goal's status in the words this screen uses. "Proposed" names an open
 *  proposal everywhere here, so a goal nobody has started says so plainly. */
export const GOAL_STATUS_WORD: Record<InitiativeStatus, string> = { ...INITIATIVE_STATUS_LABEL, proposed: "Not started" };

/** A goal that has ended: completed or cancelled. */
export const GOAL_ENDED: ReadonlySet<string> = new Set<InitiativeStatus>(["completed", "cancelled"]);

/** Whether the goal is said by its health: its owner has said how it is
 *  going and it has not ended. Otherwise its status says it. */
export const goalSaysHealth = (goal: Pick<InitiativeRow, "health" | "status">): boolean => goal.health !== "none" && !GOAL_ENDED.has(goal.status);

/** The goal's state in one lowercase word: "on track", "at risk", "not started", "planned". */
export function goalStateWord(goal: Pick<InitiativeRow, "health" | "status">): string {
  return (goalSaysHealth(goal) ? INITIATIVE_HEALTH_LABEL[goal.health] : GOAL_STATUS_WORD[goal.status]).toLowerCase();
}
