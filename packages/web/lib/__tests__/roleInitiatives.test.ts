import { describe, expect, test } from "bun:test";
import { roleInitiatives } from "../roleInitiatives";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";

const row = (over: Partial<InitiativeRow>): InitiativeRow => ({
  _id: "i", short_id: "in-0", title: "", status: "active", project_ids: [], health: "none",
  workspace: "team:t", user_id: "u", created_at: 1, updated_at: 1, ...over,
});

describe("roleInitiatives", () => {
  const rows = [
    row({ _id: "a", short_id: "in-1", title: "Carried", project_ids: ["p1", "p2", "p9"], health: "at_risk" }),
    row({ _id: "b", short_id: "in-2", title: "Owned, no project of mine", owner: { kind: "role", role_id: "r1" } }),
    row({ _id: "c", short_id: "in-3", title: "Someone else's", owner: { kind: "role", role_id: "r2" }, project_ids: ["p9"] }),
    row({ _id: "d", short_id: "in-4", title: "Finished", status: "completed", owner: { kind: "role", role_id: "r1" }, project_ids: ["p1"] }),
    row({ _id: "e", short_id: "in-5", title: "A person's", owner: { kind: "user", user_id: "r1" } }),
  ];

  test("owned first, then the ones the role's projects carry; closed and unrelated ones are left out", () => {
    expect(roleInitiatives("r1", ["p1", "p2"], rows).map((i) => [i.ref, i.owned, i.projects])).toEqual([["in-2", true, 0], ["in-1", false, 2]]);
  });

  test("a person who owns one is never read as a role with the same id", () => {
    expect(roleInitiatives("r1", [], rows).map((i) => i.ref)).toEqual(["in-2"]);
  });
});
