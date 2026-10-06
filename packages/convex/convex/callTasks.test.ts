// Tasks pulled from a call (tasks.from_call): every write path names the call
// the way prose does (cl-7 or its id), only a reader of the call may link
// it, "" unlinks, and the call's CLI read lists what was pulled from it.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { dmRoomKey } from "@codecast/shared/contracts";
import schema from "./schema";
import { hashToken } from "./apiTokens";

setDefaultTimeout(60_000);

const api = anyApi as any;
const TOKEN = "c".repeat(64);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./tasks.ts": () => import("./tasks"),
  "./transcripts.ts": () => import("./transcripts"),
  "./dispatch.ts": () => import("./dispatch"),
  "./teamFeatures.ts": () => import("./teamFeatures"),
  "./notificationRouter.ts": () => import("./notificationRouter"),
};

const backends: any[] = [];
afterEach(async () => {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

async function seed() {
  const t = convexTest(schema, modules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x", features: { calls: true } } as any);
    const other = await ctx.db.insert("teams", { name: "O", created_at: now, invite_code: "y", features: { calls: true } } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    const cat = await ctx.db.insert("users", { name: "Cat" } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    await ctx.db.insert("team_memberships", { user_id: cat, team_id: other, role: "member", joined_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: ben, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const room = dmRoomKey(String(ana), String(ben));
    for (const [u, name] of [[ana, "Ana"], [ben, "Ben"]] as const) {
      await ctx.db.insert("call_members", { room_key: room, team_id: team, user_id: u, user_name: name, joined_at: now, last_seen: now, muted: false, camera: false, sharing: false } as any);
    }
    const call = await ctx.db.insert("transcripts", {
      room_key: room, team_id: team, started_by: ana, status: "ended", started_at: now - 60_000, ended_at: now,
      routes: [], last_seq: 0, short_id: "cl-7", participants: [{ id: String(ana), name: "Ana" }, { id: String(ben), name: "Ben" }],
    } as any);
    return { team, ana, ben, cat, call };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  const task = (short_id: string) =>
    t.run(async (ctx: any) => await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", short_id)).first());
  return { t, ...ids, as, task };
}

test("a task filed from a call by its short id is listed on the call, and unlinks with ''", async () => {
  const { t, team, call, ana, as, task } = await seed();
  const made = await t.mutation(api.tasks.create, {
    api_token: TOKEN, title: "Send Ana the deck", from_call: "cl-7", source: "meeting", workspace: "team", team_id: team,
  });
  expect((await task(made.short_id)).from_call).toBe(call);

  const read = await t.query(api.transcripts.cliGetCall, { api_token: TOKEN, transcript_id: "cl-7" });
  expect(read.tasks.map((x: any) => x.short_id)).toEqual([made.short_id]);

  await as(String(ana)).mutation(api.tasks.webUpdate, { short_id: made.short_id, from_call: "" });
  expect((await task(made.short_id)).from_call).toBeUndefined();
  expect((await t.query(api.transcripts.cliGetCall, { api_token: TOKEN, transcript_id: "cl-7" })).tasks).toEqual([]);

  // The call page links by the call's full id.
  await as(String(ana)).mutation(api.tasks.webUpdate, { short_id: made.short_id, from_call: String(call) });
  expect((await task(made.short_id)).from_call).toBe(call);
});

test("the web create files a task on the call; someone who cannot read the call cannot link it", async () => {
  const { team, call, ana, cat, as, task } = await seed();
  const made = await as(String(ana)).mutation(api.tasks.webCreate, { title: "Fix the login bug", from_call: String(call), workspace: "team", team_id: team });
  expect((await task(made.short_id)).from_call).toBe(call);

  await expect(as(String(cat)).mutation(api.tasks.webCreate, { title: "Snoop", from_call: "cl-7" })).rejects.toThrow(/Call not found/);
});
