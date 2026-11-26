import { expect, test } from "bun:test";
import { unattendedOpening } from "./unattended";

test("an unattended run pins blocked when it could not finish, a person must act, or it hands them anything", () => {
  const opening = unattendedOpening();
  expect(opening).toContain("`--status blocked` if you could not finish, a person must act, or you hand them anything, even optional.");
});
