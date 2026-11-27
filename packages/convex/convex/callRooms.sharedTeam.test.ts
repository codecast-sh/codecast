// A people room bills to a team its people share (callRooms.sharedTeam). When
// they share several, it must be one that can hold calls: picking the first
// common team even with calls off refused a huddle that another shared team
// could have held.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { authorizeRoom, dmRoomKey } from "./callRooms";

setDefaultTimeout(30_000);

const backends: any[] = [];
afterEach(async () => {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

async function world(opts: { callsOnSecond: boolean }) {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    // Both people are on Quiet first (calls off) and Loud second.
    const quiet = await ctx.db.insert("teams", { name: "Quiet", features: {} } as any);
    const loud = await ctx.db.insert("teams", { name: "Loud", features: { calls: opts.callsOnSecond } } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", active_team_id: quiet } as any);
    const ben = await ctx.db.insert("users", { name: "Ben", active_team_id: quiet } as any);
    for (const team of [quiet, loud]) {
      for (const u of [ana, ben]) {
        await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
      }
    }
    return { quiet, loud, ana, ben };
  });
  return { t, ids, as: (u: string) => t.withIdentity({ subject: `${u}|session` }) };
}

test("a people room bills to a shared team that has calls on", async () => {
  const { t, ids, as } = await world({ callsOnSecond: true });
  const room = dmRoomKey(ids.ana, ids.ben);
  for (const who of [ids.ana, ids.ben]) {
    const auth: any = await t.run((ctx) => authorizeRoom(ctx, who, room));
    expect(auth).toMatchObject({ ok: true, teamId: ids.loud });
  }
  await as(ids.ana).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
});

test("with no shared team that has calls on, the room still names a common team so the refusal says calls are off", async () => {
  const { t, ids } = await world({ callsOnSecond: false });
  const auth: any = await t.run((ctx) => authorizeRoom(ctx, ids.ana, dmRoomKey(ids.ana, ids.ben)));
  expect(auth.ok).toBe(false);
  expect(String(auth.reason)).toMatch(/calls/i);
});
