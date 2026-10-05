import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";

const internal = anyApi as any;
const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./huddleBackfill.ts": () => import("./huddleBackfill"),
  "./transcripts.ts": () => import("./transcripts"),
};

const ROOM = "channel:fold-test";

/** Three fragments of one talk, each ended a few seconds before the next. */
async function fragments(t: any, pin?: (ctx: any, ids: any[], team: any, user: any) => Promise<void>) {
  return await t.run(async (ctx: any) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    const team = await ctx.db.insert("teams", { name: "T", created_by: user } as any);
    const base = Date.now() - 3_600_000;
    const ids = [];
    for (const i of [0, 1, 2]) {
      ids.push(
        await ctx.db.insert("transcripts", {
          room_key: ROOM, team_id: team, started_by: user, status: "ended",
          started_at: base + i * 60_000, ended_at: base + i * 60_000 + 55_000, routes: [], last_seq: 0,
        } as any),
      );
    }
    await pin?.(ctx, ids, team, user);
    return ids.map(String);
  });
}

const left = (t: any) => t.run(async (ctx: any) => (await ctx.db.query("transcripts").collect()).map((r: any) => String(r._id)));

describe("huddleBackfill fold", () => {
  test("fragments with nothing pointing at them fold into the first record", async () => {
    const t = convexTest(schema, modules);
    const ids = await fragments(t);
    const out = await t.mutation(internal.huddleBackfill.run, { room_key: ROOM, dryRun: false });
    expect(out.skipped).toEqual([]);
    expect(await left(t)).toEqual([ids[0]]);
  });

  test("a fragment with recordings, a public link, recorded people or guests is left whole and reported", async () => {
    const t = convexTest(schema, modules);
    const ids = await fragments(t, async (ctx, rows, team, user) => {
      await ctx.db.insert("call_recordings", {
        transcript_id: rows[1], room_key: ROOM, team_id: team, kind: "composite", status: "ready",
        r2_key: `calls/${rows[1]}/0-composite.mp4`, started_by: user, requested_at: Date.now(), updated_at: Date.now(),
      } as any);
      await ctx.db.patch(rows[2], { share_token: "tok" });
    });
    const out = await t.mutation(internal.huddleBackfill.run, { room_key: ROOM, dryRun: false });
    expect(out.skipped.map((s: any) => [s.id, s.reason])).toEqual([
      [ids[1], "it has recordings"],
      [ids[2], "it is shared by a public link"],
    ]);
    expect((await left(t)).sort()).toEqual([...ids].sort());
    const recording = await t.run(async (ctx: any) => (await ctx.db.query("call_recordings").first()).transcript_id);
    expect(String(recording)).toBe(ids[1]);
  });

  test("people seated while it recorded pin a fragment too, and a dry run reports it", async () => {
    const t = convexTest(schema, modules);
    const ids = await fragments(t, async (ctx, rows, _team, user) => {
      await ctx.db.patch(rows[1], { recorded_people: [user] });
    });
    const out = await t.mutation(internal.huddleBackfill.run, { room_key: ROOM, dryRun: true });
    expect(out.skipped).toEqual([{ id: ids[1], started_at: expect.any(Number), reason: "people were seated while it recorded" }]);
    // The fragment after it still folds, into the pinned record.
    expect(out.groups).toEqual([{ keep: ids[1], title: null, fold: [expect.objectContaining({ id: ids[2] })] }]);
  });
});
