import { expect, test } from "bun:test";
import { orgLogDoorWords } from "@codecast/shared/contracts/orgLog";

test("the org history helpers are available through the public package export", () => {
  expect(orgLogDoorWords({ door: "history", actor: {} } as any)).toBe("History");
});

test("a retire's undo names the owners it takes back from its hands", async () => {
  const { orgUndoReleasedLine } = await import("@codecast/shared/contracts/orgLog");
  const names: Record<string, string> = { a: "Ana", b: "Bo" };
  expect(orgUndoReleasedLine([{ conversation_id: "c1", user_id: "a" }], (id) => names[id])).toBe("Removes owner Ana from 1 hand");
  expect(orgUndoReleasedLine([{ conversation_id: "c1", user_id: "a" }, { conversation_id: "c2", user_id: "b" }, { conversation_id: "c3", user_id: "a" }], (id) => names[id])).toBe("Removes owners Ana, Bo from 3 hands");
});
