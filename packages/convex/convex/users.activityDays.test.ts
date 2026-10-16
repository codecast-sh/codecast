// The profile activity graph reads rolled-up days, not a year of sessions.
//
// Reading every session row of a year ("too many system operations") is what
// made the heatmap fail on an active account, so these tests pin the contract
// that replaced it:
//   - a day is rolled up into one row per (user, team) and the query reads the
//     row, not the sessions behind it;
//   - the live window (today, yesterday) still comes from the raw rows, and a
//     day is never counted twice across the two halves;
//   - a teammate reads the shared counters, the owner the totals;
//   - re-rolling a day is idempotent and corrects it.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { rollupActivityDay } from "./lib/activityDaily";
import { getUserActivityHeatmap, getUserActivityPunchcard } from "./users";

const OWNER = "u_owner" as any;
const MEMBER = "u_member" as any;
const STRANGER = "u_stranger" as any;
const TEAM = "t_team" as any;

const DAY = 86400000;
const HOUR = 3600000;
const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
const utcDate = (ms: number) => new Date(ms).toISOString().split("T")[0];

// A fixed "now" mid-day so today and yesterday are unambiguous.
const NOW = dayStart(Date.now()) + 15 * HOUR;
const TODAY = dayStart(NOW);
const YESTERDAY = TODAY - DAY;
const OLD = TODAY - 40 * DAY;

function tables(convos: any[], extra: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    users: [
      { _id: OWNER, _creationTime: 1, name: "Owner" },
      { _id: MEMBER, _creationTime: 2, name: "Member" },
      { _id: STRANGER, _creationTime: 3, name: "Stranger" },
    ],
    teams: [{ _id: TEAM, _creationTime: 4, name: "Team" }],
    team_memberships: [
      { _id: "m_owner", _creationTime: 5, user_id: OWNER, team_id: TEAM, role: "admin" },
      { _id: "m_member", _creationTime: 6, user_id: MEMBER, team_id: TEAM, role: "member" },
    ],
    conversations: convos,
    team_activity_events: [],
    session_insights: [],
    user_activity_daily: [],
    user_send_daily: [],
    user_usage_daily: [],
    ...extra,
  };
}

const session = (id: string, start: number, end: number, opts: any = {}) => ({
  _id: id,
  _creationTime: start,
  user_id: OWNER,
  team_id: TEAM,
  is_private: false,
  started_at: start,
  updated_at: end,
  message_count: 10,
  project_path: "/src/app",
  ...opts,
});

function db(t: Record<string, any[]>) {
  return makeFakeDb(t, { indexes: schemaIndexes(schema as any) });
}

function ctx(userId: string | null, t: Record<string, any[]>) {
  return {
    auth: {
      async getUserIdentity() {
        return userId ? { subject: `${userId}|session` } : null;
      },
    },
    db: db(t),
  } as any;
}

const heatmap = (uid: string | null, t: Record<string, any[]>, args: any = {}) =>
  (getUserActivityHeatmap as any)._handler(ctx(uid, t), { user_id: OWNER, team_id: TEAM, days: 371, ...args });

describe("rolled-up activity days", () => {
  // The queries read the real clock; hold it at NOW so a run just after UTC
  // midnight doesn't find today's fixture sessions still in the future.
  beforeAll(() => setSystemTime(NOW));
  afterAll(() => setSystemTime());

  test("an old day is read from its row, and the sessions behind it are never touched", async () => {
    const t = tables([session("c_old", OLD + 9 * HOUR, OLD + 11 * HOUR)]);
    await rollupActivityDay({ db: db(t) }, OWNER, OLD);

    expect(t.user_activity_daily).toHaveLength(1);
    const row = t.user_activity_daily[0];
    expect(row.day_start).toBe(OLD);
    expect(row.team_id).toBe(TEAM);
    expect(row.day_sessions).toBe(1);
    expect(row.hours.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(2, 3);

    // The query answers from the row alone: drop the session and the day holds.
    t.conversations = [];
    const days = await heatmap(OWNER, t);
    const old = days.find((d: any) => d.date === utcDate(OLD));
    expect(old).toEqual({ date: utcDate(OLD), hours: 2, sessions: 1 });
  });

  test("the live window comes from the raw rows and is not double counted", async () => {
    const t = tables([
      session("c_today", TODAY + 9 * HOUR, TODAY + 10 * HOUR),
      session("c_yesterday", YESTERDAY + 9 * HOUR, YESTERDAY + 10 * HOUR),
    ]);
    // Both days also have rows (the sweep rolls them while they are live);
    // the query must prefer the raw rows for them, counting each session once.
    await rollupActivityDay({ db: db(t) }, OWNER, TODAY);
    await rollupActivityDay({ db: db(t) }, OWNER, YESTERDAY);

    const days = await heatmap(OWNER, t);
    expect(days.find((d: any) => d.date === utcDate(TODAY))).toEqual({ date: utcDate(TODAY), hours: 1, sessions: 1 });
    expect(days.find((d: any) => d.date === utcDate(YESTERDAY))).toEqual({
      date: utcDate(YESTERDAY),
      hours: 1,
      sessions: 1,
    });
  });

  test("a teammate sees shared days only; the owner sees every day", async () => {
    const t = tables([
      session("c_shared", OLD + 9 * HOUR, OLD + 10 * HOUR),
      session("c_private", OLD + 12 * HOUR, OLD + 14 * HOUR, { is_private: true }),
    ]);
    await rollupActivityDay({ db: db(t) }, OWNER, OLD);

    const row = t.user_activity_daily[0];
    expect(row.day_sessions).toBe(2);
    expect(row.shared_day_sessions).toBe(1);

    const own = (await heatmap(OWNER, t)).find((d: any) => d.date === utcDate(OLD));
    expect(own).toEqual({ date: utcDate(OLD), hours: 3, sessions: 2 });

    const theirs = (await heatmap(MEMBER, t)).find((d: any) => d.date === utcDate(OLD));
    expect(theirs).toEqual({ date: utcDate(OLD), hours: 1, sessions: 1 });

    expect(await heatmap(STRANGER, t)).toEqual([]);
  });

  test("the live window keeps the same privacy gate as the rolled-up days", async () => {
    const t = tables([
      session("c_live_shared", TODAY + 9 * HOUR, TODAY + 10 * HOUR),
      session("c_live_private", TODAY + 11 * HOUR, TODAY + 12 * HOUR, { is_private: true }),
    ]);
    const own = (await heatmap(OWNER, t)).find((d: any) => d.date === utcDate(TODAY));
    expect(own!.sessions).toBe(2);
    const theirs = (await heatmap(MEMBER, t)).find((d: any) => d.date === utcDate(TODAY));
    expect(theirs!.sessions).toBe(1);
  });

  test("re-rolling a day corrects it instead of adding to it", async () => {
    const t = tables([session("c_old", OLD + 9 * HOUR, OLD + 11 * HOUR)]);
    await rollupActivityDay({ db: db(t) }, OWNER, OLD);
    // A later sync extends the session and adds another.
    t.conversations[0].updated_at = OLD + 12 * HOUR;
    t.conversations.push(session("c_old2", OLD + 13 * HOUR, OLD + 14 * HOUR));
    await rollupActivityDay({ db: db(t) }, OWNER, OLD);

    expect(t.user_activity_daily).toHaveLength(1);
    expect(t.user_activity_daily[0].day_sessions).toBe(2);
    expect(t.user_activity_daily[0].hours.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(4, 3);

    // The day emptying out removes its row rather than leaving a stale one.
    t.conversations = [];
    await rollupActivityDay({ db: db(t) }, OWNER, OLD);
    expect(t.user_activity_daily).toHaveLength(0);
  });

  test("an event stands in for a session whose conversation is gone", async () => {
    const t = tables([], {
      team_activity_events: [
        {
          _id: "e_done",
          _creationTime: OLD,
          team_id: TEAM,
          actor_user_id: OWNER,
          event_type: "session_completed",
          title: "Gone session",
          timestamp: OLD + 10 * HOUR,
          metadata: { duration_ms: 2 * HOUR, message_count: 4 },
        },
      ],
    });
    await rollupActivityDay({ db: db(t) }, OWNER, OLD);
    const row = t.user_activity_daily[0];
    expect(row.day_sessions).toBe(1);
    expect(row.hours.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(2, 3);
    // No privacy facts to judge: it counts for the team, as it did before.
    expect(row.shared_day_sessions).toBe(1);
  });

  test("an event whose conversation still exists is not a second session", async () => {
    const t = tables([session("c_old", OLD + 9 * HOUR, OLD + 11 * HOUR)], {
      team_activity_events: [
        {
          _id: "e_start",
          _creationTime: OLD,
          team_id: TEAM,
          actor_user_id: OWNER,
          event_type: "session_started",
          title: "Same session",
          timestamp: OLD + 9 * HOUR,
          related_conversation_id: "c_old",
        },
      ],
    });
    await rollupActivityDay({ db: db(t) }, OWNER, OLD);
    expect(t.user_activity_daily[0].day_sessions).toBe(1);
  });

  test("a session that began before the live window stays inside it", async () => {
    // Its credit belongs to its last activity day; spreading it backwards
    // would land on days the rolled-up rows already count.
    const t = tables([session("c_long", TODAY - 10 * DAY, TODAY + 10 * HOUR)]);
    const rows = await (getUserActivityPunchcard as any)._handler(ctx(OWNER, t), {
      user_id: OWNER,
      team_id: TEAM,
      days: 371,
      tz_offset_minutes: 0,
    });
    const dates = rows.filter((r: any) => r.day_sessions > 0).map((r: any) => r.date);
    expect(dates).toEqual([utcDate(YESTERDAY), utcDate(TODAY)]);
    const total = rows.reduce((sum: number, r: any) => sum + r.hours.reduce((a: number, b: number) => a + b, 0), 0);
    // The 8h day cap, counted once (each hour cell is rounded to 2 decimals).
    expect(total).toBeCloseTo(8, 0);
  });

  test("the punchcard reads an old day's hour buckets from its row", async () => {
    const t = tables([session("c_old", OLD + 9 * HOUR, OLD + 10 * HOUR)]);
    await rollupActivityDay({ db: db(t) }, OWNER, OLD);
    t.conversations = [];

    const rows = await (getUserActivityPunchcard as any)._handler(ctx(OWNER, t), {
      user_id: OWNER,
      team_id: TEAM,
      days: 371,
      tz_offset_minutes: 0,
    });
    const day = rows.find((r: any) => r.date === utcDate(OLD));
    expect(day.day_sessions).toBe(1);
    expect(day.hours[9]).toBeCloseTo(1, 2);
    expect(day.hours.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1, 2);
  });
});
