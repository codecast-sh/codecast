import { describe, expect, test } from "bun:test";
import { applyOwnersChangeTo, driverOf, listedOwnerIds, takeOverBySend, type OwnersFacts } from "./sessionOwners";
import { roleDrives } from "./inboxProjection";

const base: OwnersFacts = { rows: [], author_id: null, runner_id: "me", bots: [], role_id: null, role_started: false, standing_role_id: null, driver_user_id: null, primary_id: null };
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

  test("who drives is the inbox's rule: the role exactly while roleDrives says so", () => {
    const cases: Array<Partial<OwnersFacts> & { owners: string[] }> = [
      { role_id: "r1", owners: ["me"] },
      { role_id: "r1", driver_user_id: "me", owners: ["me"] },
      // A wheel held by someone no longer an owner still pauses the role.
      { role_id: "r1", driver_user_id: "gone", owners: ["me"] },
      { driver_user_id: "me", owners: ["me", "ashot"] },
      { owners: ["me"] },
    ];
    for (const { owners, ...c } of cases) {
      const f = { ...base, ...c };
      expect(driverOf(f, owners)?.kind === "role").toBe(roleDrives({ org_role_id: f.role_id, driver_user_id: f.driver_user_id }));
    }
    expect(driverOf({ ...base, role_id: "r1", driver_user_id: "gone" }, ["me"])).toEqual({ kind: "user", user_id: "me" });
  });

  test("a run a role started has no starter: adding a teammate writes no row for the runner", () => {
    const run = { ...base, role_id: "r1", role_started: true };
    expect(listedOwnerIds(run)).toEqual([]);
    expect(listedOwnerIds(applyOwnersChangeTo(run, { add: ["ashot"] }, at))).toEqual(["ashot"]);
    expect(listedOwnerIds({ ...base, role_id: "r1", standing_role_id: "r0" })).toEqual([]);
    // Released from its role, it is the runner's again; a person's own session filed under a role stays theirs.
    expect(listedOwnerIds({ ...run, role_id: null })).toEqual(["me"]);
    expect(listedOwnerIds({ ...base, role_id: "r1" })).toEqual(["me"]);
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

describe("a person's own send takes the wheel", () => {
  const row = (user_id: string, added_at: number) => ({ user_id, added_at });

  test("an owner sending into a session its role drives becomes driver; the role pauses", () => {
    const f = { ...base, rows: [row("me", 1)], role_id: "r1" };
    const next = takeOverBySend(f, "me", 100)!;
    expect(next.driver_user_id).toBe("me");
    expect(roleDrives({ org_role_id: next.role_id, driver_user_id: next.driver_user_id })).toBe(false);
    expect(listedOwnerIds(next)).toEqual(["me"]);
  });

  test("another person driving: the owner who sends takes it from them", () => {
    const f = { ...base, rows: [row("me", 1), row("ashot", 2)], driver_user_id: "ashot", primary_id: "ashot" };
    expect(takeOverBySend(f, "me", 100)?.driver_user_id).toBe("me");
  });

  test("the driver's own send, a non-owner's send and a role's own session change nothing", () => {
    expect(takeOverBySend({ ...base, rows: [row("me", 1)] }, "me", 100)).toBeNull();
    expect(takeOverBySend({ ...base, rows: [row("me", 1)], role_id: "r1" }, "stranger", 100)).toBeNull();
    expect(takeOverBySend({ ...base, role_id: "r1", standing_role_id: "r2" }, "me", 100)).toBeNull();
  });

  test("the runner of a run a role started takes it and becomes its owner, so it stays in their inbox", () => {
    const f = { ...base, role_id: "r1", role_started: true };
    expect(listedOwnerIds(f)).toEqual([]);
    const next = takeOverBySend(f, "me", 100)!;
    expect(listedOwnerIds(next)).toEqual(["me"]);
    expect(next.driver_user_id).toBe("me");
    expect(driverOf(next, listedOwnerIds(next))).toEqual({ kind: "user", user_id: "me" });
  });

  test("a runner who is not listed keeps the starter as an owner when it takes over", () => {
    const f = { ...base, author_id: "ashot", runner_id: "me", role_id: "r1" };
    expect(listedOwnerIds(takeOverBySend(f, "me", 100)!)).toEqual(["ashot", "me"]);
  });
});
