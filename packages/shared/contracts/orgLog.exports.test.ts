import { expect, test } from "bun:test";
import { orgLogDoorWords } from "@codecast/shared/contracts/orgLog";

test("the org history helpers are available through the public package export", () => {
  expect(orgLogDoorWords({ door: "history", actor: {} } as any)).toBe("History");
});
