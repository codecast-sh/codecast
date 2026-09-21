import { CHIEF_OF_STAFF_HANDLE } from "../components/org/orgStaffingTypes";

export type UnseatChoice = "keep" | "retire";

export const UNSEAT_CHOICES: readonly (readonly [UnseatChoice, string, string])[] = [
  ["keep", "Keep it running as a plain agent", "It gets its old title back and stops answering as the role."],
  ["retire", "Retire it with the seat", "The thread is kept and stops waking."],
];

/** The choice a retire carries: asked for the chief of staff, absent for any other seat. */
export function isChiefOfStaff(role: { handle: string }): boolean {
  return role.handle === CHIEF_OF_STAFF_HANDLE;
}

/** What the toast says after a retire, the same words on every surface. */
export function retireToastText(roleName: string, choice: UnseatChoice | undefined): string {
  return choice === "keep"
    ? `Retired ${roleName}; its agent keeps running as a plain agent`
    : choice === "retire"
      ? `Retired ${roleName} and its standing agent; the thread is kept`
      : `Retired ${roleName}`;
}
