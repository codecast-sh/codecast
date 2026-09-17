/** A named row this close to the newest one is already on the tail. Holding
 *  the bottom pin and centering it is what a chat notification used to do:
 *  paint mid-list, then walk down to the composer. */
export const TAIL_HOLD_ROWS = 8;

/** True only for a permalink into history. A missing target, or one already
 *  on the tail, opens at the bottom like any other channel open. */
export function shouldHoldChatLanding(targetIndex: number, rowCount: number): boolean {
  if (targetIndex < 0) return false;
  return targetIndex < rowCount - TAIL_HOLD_ROWS;
}
