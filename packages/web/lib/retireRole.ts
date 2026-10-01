import { HEAD_OF_PEOPLE_HANDLE, isHeadOfPeopleRole } from "../components/org/orgStaffingTypes";

export type UnseatChoice = "keep" | "retire";

export const UNSEAT_CHOICES: readonly (readonly [UnseatChoice, string, string])[] = [
  ["keep", "Keep it running as a plain agent", "It gets its old title back and stops answering as the role."],
  ["retire", "Retire it with the role", "The thread is kept and stops waking."],
];

/** The choice a retire carries: asked for the head of people, absent for any other seat. */
export function isHeadOfPeople(role: { handle: string }): boolean {
  return isHeadOfPeopleRole(role);
}

/** What the toast says after a retire, the same words on every surface. */
export function retireToastText(roleName: string, choice: UnseatChoice | undefined): string {
  return choice === "keep"
    ? `Retired ${roleName}; its agent keeps running as a plain agent`
    : choice === "retire"
      ? `Retired ${roleName}; its thread is kept`
      : `Retired ${roleName}`;
}
