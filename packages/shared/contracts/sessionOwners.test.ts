import { describe, expect, test } from "bun:test";
import { applyOwnersChangeTo, driverOf, listedOwnerIds, type OwnersFacts } from "./sessionOwners";

const base: OwnersFacts = { rows: [], author_id: null, runner_id: "me", bots: [], role_id: null, driver_user_id: null, primary_id: null };
const at = { actor: "me", now: 100 };

describe("session owners, as one rule for the server and the store", () => {
  test("a session with no rows is owned and driven by the person who started it", () => {
    expect(listedOwnerIds(base)).toEqual(["me"]);
    expect(driverOf(base, ["me"])).toEqual({ kind: "user", user_id: "me" });
    expect(listedOwnerIds({ ...base, runner_id: "bot", bots: ["bot"] })).toEqual([]);
  });

  test("adding a teammate writes the starter's row first and keeps the wheel with them", () => {
    const next = applyOwnersChangeTo(base, { add: ["ashot"] }, at);
    expect(listedOwnerIds(next)).toEqual(["me", "ashot"]);
    expect(next.primary_id).toBe("ashot");
    expect(next.driver_user_id).toBe("me");
  });

  test("a role drives until a person takes the wheel", () => {
    const filed = applyOwnersChangeTo({ ...base, driver_user_id: "me" }, { role: "r1" }, at);
    expect(filed.driver_user_id).toBeNull();
    expect(driverOf(filed, listedOwnerIds(filed))).toEqual({ kind: "role", role_id: "r1" });
    const taken = applyOwnersChangeTo(filed, { driver: { kind: "user", user_id: "me" } }, at);
    expect(driverOf(taken, listedOwnerIds(taken))).toEqual({ kind: "user", user_id: "me" });
  });

  test("a restored row goes back to its place", () => {
    const three = { ...base, rows: [{ user_id: "a", added_at: 1 }, { user_id: "c", added_at: 3 }] };
    expect(listedOwnerIds(applyOwnersChangeTo(three, { restore: [{ user_id: "b", added_at: 2 }] }, at))).toEqual(["a", "b", "c"]);
  });

  test("leaving by a move leaves the new runner owning it", () => {
    const next = applyOwnersChangeTo(base, { leave: { move_to: { runner_id: "ashot", runner_is_bot: false } } }, at);
    expect(next.author_id).toBe("me");
    expect(listedOwnerIds(next)).toEqual(["ashot"]);
  });
});
