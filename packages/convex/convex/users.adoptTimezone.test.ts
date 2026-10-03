// A profile with no timezone takes its device's (store adoptTimezone), and a
// zone change that moves a Changes team's day cut re-marks the team's days.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./users.ts": () => import("./users"),
  "./changes.ts": () => import("./changes"),
  "./changesSchedule.ts": () => import("./changesSchedule"),
  "./changesProse.ts": () => import("./changesProse"),
  "./changesWeek.ts": () => import("./changesWeek"),
};

async function setup(opts: { flag: boolean; role?: "admin" | "member"; timezone?: string }) {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: now, invite_code: "acme", ...(opts.flag ? { features: { changes: true } } : {}) } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", ...(opts.timezone ? { timezone: opts.timezone } : {}) } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: opts.role ?? "admin", joined_at: now - 1, visibility: "full" } as any);
    // An edition from when the team's day was cut in UTC.
    await ctx.db.insert("digests", { team_id: team, repository: "acme/app", scope: "day", date: new Date(now).toISOString().slice(0, 10), narrative: "", generated_at: now, status: "final" } as any);
    return { team, ana };
  });
  const as = t.withIdentity({ subject: `${ids.ana}|session` });
  const user = () => t.run(async (ctx) => ctx.db.get(ids.ana));
  const dirty = () => t.run(async (ctx) => ctx.db.query("change_dirty").collect());
  const backfills = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.name.includes("backfill")));
  return { t, ids, as, user, dirty, backfills };
}

describe("adoptTimezone", () => {
  test("fills an empty profile zone and recuts the team the admin's zone decides", async () => {
    const s = await setup({ flag: true });
    await s.as.mutation(api.users.adoptTimezone, { timezone: "America/New_York" });
    expect((await s.user())?.timezone).toBe("America/New_York");
    expect((await s.dirty()).length).toBe(1);
    expect((await s.backfills()).length).toBe(1);
  });

  test("never replaces a zone the person chose, and ignores a zone that is not one", async () => {
    const s = await setup({ flag: true, timezone: "Europe/Paris" });
    await s.as.mutation(api.users.adoptTimezone, { timezone: "America/New_York" });
    expect((await s.user())?.timezone).toBe("Europe/Paris");
    const blank = await setup({ flag: true });
    await blank.as.mutation(api.users.adoptTimezone, { timezone: "Not/AZone" });
    expect((await blank.user())?.timezone).toBeUndefined();
    expect((await blank.backfills()).length).toBe(0);
  });

  test("a member's zone, or a team with Changes off, recuts nothing", async () => {
    for (const s of [await setup({ flag: true, role: "member" }), await setup({ flag: false })]) {
      await s.as.mutation(api.users.adoptTimezone, { timezone: "America/New_York" });
      expect((await s.user())?.timezone).toBe("America/New_York");
      expect((await s.dirty()).length).toBe(0);
      expect((await s.backfills()).length).toBe(0);
    }
  });

  test("a profile edit that moves the cut recuts too; one that keeps it does not", async () => {
    const s = await setup({ flag: true, timezone: "America/New_York" });
    await s.as.mutation(api.users.updateProfile, { timezone: "America/New_York" });
    expect((await s.backfills()).length).toBe(0);
    await s.as.mutation(api.users.updateProfile, { timezone: "Asia/Tokyo" });
    expect((await s.backfills()).length).toBe(1);
  });
});
