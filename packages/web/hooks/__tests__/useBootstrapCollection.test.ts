import { describe, expect, test, beforeEach } from "bun:test";
import { loadFloorOnce, bootstrapKey, floorScopeKeys, resetBootstrapFloors } from "../useBootstrapCollection";

// The bootstrap floor (sync-log-cargo E8) is a one-shot per (collection, args)
// per page session: the rows land in the store exactly once, however many
// mounts share the key, and a failed fetch is forgotten so the next mount
// retries. Re-applying a stale snapshot on remount would overwrite log patches
// that arrived after the floor was cut.

beforeEach(() => resetBootstrapFloors());

describe("loadFloorOnce", () => {
  test("two mounts on one key fetch once and apply once", async () => {
    let fetches = 0;
    const applied: any[][] = [];
    const fetch = async () => { fetches++; return [{ _id: "a" }]; };
    const key = bootstrapKey("tasks", { team_id: "T" });
    const [r1, r2] = await Promise.all([
      loadFloorOnce(key, fetch, (rows) => applied.push(rows)),
      loadFloorOnce(key, fetch, (rows) => applied.push(rows)),
    ]);
    expect(fetches).toBe(1);
    expect(applied).toHaveLength(1);
    expect(r1).toEqual(r2);
    // A later remount (the floor already landed) gets the rows but applies nothing.
    await loadFloorOnce(key, fetch, (rows) => applied.push(rows));
    expect(applied).toHaveLength(1);
  });

  test("a non-array payload applies as an empty floor", async () => {
    const applied: any[][] = [];
    await loadFloorOnce("k", async () => ({ nope: true }), (rows) => applied.push(rows));
    expect(applied).toEqual([[]]);
  });

  test("a failed fetch is forgotten so the next mount retries", async () => {
    let n = 0;
    const fetch = async () => { if (++n === 1) throw new Error("offline"); return [{ _id: "b" }]; };
    await expect(loadFloorOnce("k", fetch, () => {})).rejects.toThrow("offline");
    const applied: any[][] = [];
    await loadFloorOnce("k", fetch, (rows) => applied.push(rows));
    expect(n).toBe(2);
    expect(applied).toEqual([[{ _id: "b" }]]);
  });

  test("a floor whose fence went stale (resync, sign-out) resolves but applies nothing", async () => {
    const applied: any[][] = [];
    let live = true;
    const p = loadFloorOnce("k", async () => { live = false; return [{ _id: "stale" }]; }, (rows) => applied.push(rows), () => live);
    expect(await p).toEqual([{ _id: "stale" }]);
    expect(applied).toEqual([]);
  });

  test("distinct args are distinct floors", async () => {
    let fetches = 0;
    const fetch = async () => { fetches++; return []; };
    await loadFloorOnce(bootstrapKey("docs", { workspace: "personal" }), fetch, () => {});
    await loadFloorOnce(bootstrapKey("docs", { workspace: "team", team_id: "T" }), fetch, () => {});
    expect(fetches).toBe(2);
  });
});

describe("floorScopeKeys", () => {
  test("a personal floor waits on the user scope; a team floor on the user AND team scopes", () => {
    expect(floorScopeKeys({ workspace: "personal" }, "u1")).toEqual(["user:u1"]);
    expect(floorScopeKeys({ workspace: "team", team_id: "T" }, "u1")).toEqual(["user:u1", "team:T"]);
  });
  test("unresolvable until there is a principal and args", () => {
    expect(floorScopeKeys("skip", "u1")).toBeNull();
    expect(floorScopeKeys({ workspace: "personal" }, null)).toBeNull();
  });
});
