// Who reads a person's activity counters and spend (getUserActivityPunchcard,
// the team charts page, published page `usage` readers).
//  - The send and usage counters are pre-summed per team. They used to be read
//    for any signed-in caller: no team_id handed a stranger the person's total
//    across every team and personal work, and someone else's team_id handed
//    them that team's rows. Anyone but the person now reads one team they
//    belong to, or nothing.
//  - Tokens and spend per person reach a team's admins, and every member only
//    once the team turns on member_spend.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { dayStartUtc } from "./lib/userSend";
import { PAGE_READERS } from "./lib/pageReaders";

const hours = (n: number) => { const h = new Array(24).fill(0); h[12] = n; return h; };

async function setup(features?: Record<string, boolean>) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = (name: string, extra: Record<string, unknown> = {}) => ctx.db.insert("users", { name, ...extra } as any);
    const owner = await user("Owner");
    const admin = await user("Admin");
    const member = await user("Member");
    const stranger = await user("Stranger");
    const removed = await user("Removed");
    const hider = await user("Hider", { hide_activity: true });
    const team = await ctx.db.insert("teams", { name: "T", created_at: 0, invite_code: "t", ...(features ? { features } : {}) } as any);
    const other = await ctx.db.insert("teams", { name: "O", created_at: 0, invite_code: "o" } as any);
    const join = (user_id: any, team_id: any, role: "admin" | "member") =>
      ctx.db.insert("team_memberships", { user_id, team_id, role, joined_at: 0 } as any);
    await join(owner, team, "member");
    await join(admin, team, "admin");
    await join(member, team, "member");
    await join(hider, team, "member");
    await join(owner, other, "member");
    await join(stranger, other, "admin");
    const day = dayStartUtc(Date.now() - 2 * 86_400_000);
    // The owner's counters in T, in O, and in personal work.
    for (const [team_id, n] of [[team, 1], [other, 10], [undefined, 100]] as const) {
      await ctx.db.insert("user_send_daily", { user_id: owner, team_id, day_start: day, total: n, hours: hours(n), updated_at: 0 } as any);
      await ctx.db.insert("user_usage_daily", { user_id: owner, team_id, day_start: day, token_hours: hours(n * 1000), spend_hours: hours(n), updated_at: 0 } as any);
    }
    await ctx.db.insert("user_usage_daily", { user_id: hider, team_id: team, day_start: day, token_hours: hours(5000), spend_hours: hours(5), updated_at: 0 } as any);
    return { owner, admin, member, stranger, removed, hider, team, other };
  });
  const punch = (viewer: any, team_id?: any) =>
    t.withIdentity({ subject: viewer }).query(api.users.getUserActivityPunchcard, { user_id: ids.owner, team_id, days: 30 });
  return { t, ids, punch };
}

const total = (rows: any[], field: "sends" | "spend" | "tokens") =>
  rows.reduce((a, r) => a + (r[field] ?? []).reduce((x: number, y: number) => x + y, 0), 0);

describe("getUserActivityPunchcard audience", () => {
  test("the person sees every team's counters and their own spend", async () => {
    const { ids, punch } = await setup();
    const all = await punch(ids.owner);
    expect(total(all, "sends")).toBe(111);
    expect(total(all, "spend")).toBe(111);
    expect(total(await punch(ids.owner, ids.team), "spend")).toBe(1);
  });

  test("a stranger reads nothing, with no team, the person's other team, or a team they are not in", async () => {
    const { ids, punch } = await setup();
    expect(await punch(ids.stranger)).toEqual([]);
    expect(await punch(ids.stranger, ids.team)).toEqual([]);
    expect(await punch(ids.removed, ids.team)).toEqual([]);
  });

  test("a teammate reads only the shared team, never the cross-team total", async () => {
    const { ids, punch } = await setup();
    expect(await punch(ids.member)).toEqual([]);
    const inTeam = await punch(ids.member, ids.team);
    expect(total(inTeam, "sends")).toBe(1);
  });

  test("spend reaches admins only by default", async () => {
    const { ids, punch } = await setup();
    expect(total(await punch(ids.member, ids.team), "spend")).toBe(0);
    expect(total(await punch(ids.member, ids.team), "tokens")).toBe(0);
    expect(total(await punch(ids.admin, ids.team), "spend")).toBe(1);
    // Admin of the OTHER team the person is in reads that team's spend, not T's.
    expect(total(await punch(ids.stranger, ids.other), "spend")).toBe(10);
  });

  test("member_spend opens spend to every member, still only inside the team", async () => {
    const { ids, punch } = await setup({ member_spend: true });
    expect(total(await punch(ids.member, ids.team), "spend")).toBe(1);
    expect(await punch(ids.member)).toEqual([]);
    expect(await punch(ids.removed, ids.team)).toEqual([]);
  });
});

describe("page usage reader", () => {
  const usage = PAGE_READERS.usage as any;
  const read = (t: any, owner: any, team: any, group_by: string) =>
    t.run((ctx: any) => usage.page(ctx, { owner, workspace: `team:${team}` }, { days: 30, group_by }, null, Date.now()));

  test("spend by person needs an admin publisher unless member_spend is on", async () => {
    const { t, ids } = await setup();
    await expect(read(t, ids.member, ids.team, "person")).rejects.toThrow("admins only");
    const byPerson = await read(t, ids.admin, ids.team, "person");
    expect(byPerson.items.map((r: any[]) => r[1])).toEqual(["Owner"]);
    // Team totals stay open to members; the hidden member is left out.
    const totals = await read(t, ids.member, ids.team, "none");
    expect(totals.items.reduce((a: number, r: any[]) => a + r[3], 0)).toBe(1);

    const open = await setup({ member_spend: true });
    expect((await read(open.t, open.ids.member, open.ids.team, "person")).items).toHaveLength(1);
  });
});
