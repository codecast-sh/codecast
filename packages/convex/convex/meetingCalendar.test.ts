// Meeting bots from calendars (sd-3233: only meetings people turn on). A
// meeting with a link gets no bot until its person switches it on or turns
// on join-all; a wanted meeting within a day gets a scheduled bot; a meeting
// moved, cancelled or switched off has its unjoined bot taken back; two
// teammates on one meeting share one bot and both read its call.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);
const api = anyApi as any;
const HOUR = 60 * 60_000;

// Recall's create answers every bot with a fresh id; nothing leaves the test.
const realFetch = globalThis.fetch;
let botSeq = 0;
beforeAll(() => {
  process.env.RECALL_API_KEY = "k";
  process.env.CONVEX_SITE_URL = "https://site.test";
  globalThis.fetch = (async (url: any, init: any = {}) => {
    if (String(url).endsWith("/api/v1/bot/") && init.method === "POST") return new Response(JSON.stringify({ id: `bot_${++botSeq}` }), { status: 201 });
    return new Response("{}", { status: 200 });
  }) as any;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.RECALL_API_KEY;
});

async function seed() {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x", features: { calls: true } } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", active_team_id: team } as any);
    const ben = await ctx.db.insert("users", { name: "Ben", active_team_id: team } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    return { team, ana, ben };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  const file = (user: string, meetings: any[]) =>
    t.mutation((anyApi as any).meetingCalendar.applyCalendar, { user_id: user, read_at: Date.now(), meetings });
  const bots = () => t.run(async (ctx: any) => await ctx.db.query("meeting_bots").collect());
  const rows = (u: string) => as(u).query(api.meetingCalendar.listUpcoming, {});
  return { t, ...ids, as, file, bots, rows };
}

const meeting = (id: string, startsIn: number, url = "https://meet.google.com/abc-defg-hij") => ({
  event_id: id,
  title: `Meeting ${id}`,
  starts_at: Date.now() + startsIn,
  ends_at: Date.now() + startsIn + HOUR,
  meeting_url: url,
  platform: "google_meet",
});

describe("calendar meetings", () => {
  test("nothing joins until the person turns a meeting on; then a bot is scheduled before its start", async () => {
    const { file, bots, rows, as, ana } = await seed();
    await file(String(ana), [meeting("e1", 2 * HOUR), meeting("e2", 3 * 24 * HOUR, "https://meet.google.com/xyz-abcd-efg")]);
    expect(await bots()).toHaveLength(0);
    const listed = await rows(String(ana));
    expect(listed.map((r: any) => [r.event_id, r.choice, r.meet_id])).toEqual([["e1", null, null], ["e2", null, null]]);

    await as(String(ana)).mutation(api.meetingCalendar.setMeetingChoice, { id: listed[0]._id, choice: "on" });
    // A meeting three days out waits for the sweep that brings it within a day.
    await as(String(ana)).mutation(api.meetingCalendar.setMeetingChoice, { id: listed[1]._id, choice: "on" });
    const made = await bots();
    expect(made).toHaveLength(1);
    expect(made[0].calendar_event_id).toBe("e1");
    expect(made[0].join_at).toBe(listed[0].starts_at - 60_000);
    expect((await rows(String(ana)))[0].meet_id).toBe(made[0].meet_id);
  });

  test("join-all covers every meeting the person did not switch off", async () => {
    const { file, bots, rows, as, ana } = await seed();
    await file(String(ana), [meeting("e1", HOUR), meeting("e2", 2 * HOUR, "https://zoom.us/j/123")]);
    const listed = await rows(String(ana));
    await as(String(ana)).mutation(api.meetingCalendar.setMeetingChoice, { id: listed[1]._id, choice: "off" });
    await as(String(ana)).mutation(api.meetingCalendar.setJoinAll, { join_all: true });
    expect((await bots()).map((b: any) => b.calendar_event_id)).toEqual(["e1"]);
    expect((await as(String(ana)).query(api.meetingCalendar.getSettings, {}))[0].join_all).toBe(true);

    // Turning join-all off takes back the bot that had not joined yet.
    await as(String(ana)).mutation(api.meetingCalendar.setJoinAll, { join_all: false });
    expect((await bots()).map((b: any) => b.status)).toEqual(["cancelled"]);
  });

  test("a moved meeting gets a bot at its new time; a cancelled one loses its bot", async () => {
    const { file, bots, rows, as, ana } = await seed();
    const m = meeting("e1", 2 * HOUR);
    await file(String(ana), [m]);
    await as(String(ana)).mutation(api.meetingCalendar.setMeetingChoice, { id: (await rows(String(ana)))[0]._id, choice: "on" });
    // Recall answered the create, so the bot is scheduled.
    await new Promise((r) => setTimeout(r, 50));
    const first = (await bots())[0];
    expect(first.status).toBe("scheduled");

    await file(String(ana), [{ ...m, starts_at: m.starts_at + HOUR, ends_at: m.ends_at + HOUR }]);
    const moved = await bots();
    // The first bot is taken back; a new one is asked for at the new time.
    expect(moved.filter((b: any) => b.status === "cancelled").map((b: any) => b._id)).toEqual([first._id]);
    const live = moved.find((b: any) => b.status !== "cancelled");
    expect(live.join_at).toBe(m.starts_at + HOUR - 60_000);
    expect((await rows(String(ana)))[0].choice).toBe("on");

    await file(String(ana), []);
    expect((await bots()).every((b: any) => b.status === "cancelled")).toBe(true);
    expect(await rows(String(ana))).toHaveLength(0);
  });

  test("two teammates on one meeting share one bot, and both read its call", async () => {
    const { t, file, bots, rows, as, ana, ben } = await seed();
    const m = meeting("e1", HOUR);
    await file(String(ana), [m]);
    await file(String(ben), [{ ...m, event_id: "e1-ben" }]);
    await as(String(ana)).mutation(api.meetingCalendar.setMeetingChoice, { id: (await rows(String(ana)))[0]._id, choice: "on" });
    await as(String(ben)).mutation(api.meetingCalendar.setMeetingChoice, { id: (await rows(String(ben)))[0]._id, choice: "on" });
    const all = await bots();
    expect(all).toHaveLength(1);
    expect(all[0].also_for.map(String)).toEqual([String(ben)]);

    // Ana switches off: the bot passes to Ben instead of leaving the meeting.
    await as(String(ana)).mutation(api.meetingCalendar.setMeetingChoice, { id: (await rows(String(ana)))[0]._id, choice: "off" });
    const after = (await bots())[0];
    expect(after.status).not.toBe("cancelled");
    expect(String(after.user_id)).toBe(String(ben));
    expect(after.also_for).toEqual([]);
    void t;
  });

  test("the settings say whether a calendar is connected", async () => {
    const { t, as, ana } = await seed();
    expect((await as(String(ana)).query(api.meetingCalendar.getSettings, {}))[0].calendar).toBe("not_connected");
    await t.run(async (ctx: any) => {
      await ctx.db.insert("google_installations", { scope_user_id: ana, email: "ana@x.test", refresh_token_enc: "x", granted_scopes: ["https://www.googleapis.com/auth/gmail.readonly"], created_at: 1, updated_at: 1 });
    });
    expect((await as(String(ana)).query(api.meetingCalendar.getSettings, {}))[0].calendar).toBe("missing_scope");
    await t.run(async (ctx: any) => {
      const row = await ctx.db.query("google_installations").first();
      await ctx.db.patch(row._id, { granted_scopes: [...row.granted_scopes, "https://www.googleapis.com/auth/calendar.events"] });
    });
    expect((await as(String(ana)).query(api.meetingCalendar.getSettings, {}))[0].calendar).toBe("connected");
    expect(await t.query((anyApi as any).meetingCalendar.calendarUsers, {})).toEqual([ana]);
  });
});
