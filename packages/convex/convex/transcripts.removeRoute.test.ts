import { describe, expect, test } from "bun:test";
import { removeRoute } from "./transcripts";
import { makeFakeDb } from "./testDb";

// An agent brought into a huddle hears everyone in it, so anyone in it may
// show the agent out, not only whoever brought it in.
describe("removeRoute", () => {
  const live = (over: Record<string, unknown> = {}) => ({
    _id: "t1",
    room_key: "dm:ua:ub",
    team_id: "team1",
    started_by: "ua",
    status: "live",
    started_at: 1_000,
    routes: [{ kind: "session", target: "conv1", mode: "live", sent_seq: 0, added_by: "ua" }],
    last_seq: 0,
    ...over,
  });
  const ctx = (as: string, t: any) => ({
    db: makeFakeDb({
      transcripts: [t],
      teams: [{ _id: "team1", name: "T", features: { calls: true } }],
      team_memberships: [
        { _id: "m1", user_id: "ua", team_id: "team1" },
        { _id: "m2", user_id: "ub", team_id: "team1" },
        { _id: "m3", user_id: "uc", team_id: "team1" },
      ],
      call_members: [],
      call_invites: [],
      conversations: [],
    }),
    auth: { async getUserIdentity() { return { subject: `${as}|session` }; } },
    scheduler: { async runAfter() {} },
  });
  const remove = (c: any) => (removeRoute as any)._handler(c, { transcript_id: "t1", kind: "session", target: "conv1" });
  const routesAfter = async (c: any) => (await c.db.get("t1")).routes;

  test("someone else in the huddle can remove an agent they did not add", async () => {
    const c = ctx("ub", live());
    await remove(c);
    expect(await routesAfter(c)).toEqual([]);
  });

  test("someone outside the huddle cannot", async () => {
    await expect(remove(ctx("uc", live()))).rejects.toThrow("Not your route");
  });

  test("after the huddle ends only the scribe or the adder can", async () => {
    await expect(remove(ctx("ub", live({ status: "ended" })))).rejects.toThrow("Not your route");
    const c = ctx("ua", live({ status: "ended" }));
    await remove(c);
    expect(await routesAfter(c)).toEqual([]);
  });
});
