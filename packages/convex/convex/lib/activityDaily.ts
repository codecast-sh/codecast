import type { Doc, Id } from "../_generated/dataModel";
import { dayStartUtc } from "./userSend";
import { createTeamFeedFilter } from "../privacy";
import type { ActivityInterval } from "./activityPunchcard";

// Per-day session-activity counters: the profile contribution graph, the hour
// punchcard and the team charts all read these rows.
//
// The raw sources are one row per session — `conversations` (authoritative:
// real duration, message count, project, privacy), plus `team_activity_events`
// and `session_insights` as the fallback for a session whose conversation row
// is gone. An active account runs tens of thousands of sessions a year, and
// reading a year of them in one query blew Convex's per-transaction
// system-operation ceiling: the profile heatmap failed outright ("too many
// system operations") and took ~18s when it did answer.
//
// So a day is rolled up once into one small row per (user, team, UTC day), and
// read as a row after that. Only the live window (today and yesterday) is
// still computed from the raw rows, where one day of sessions is a few hundred
// documents.

const HOUR = 3600000;
const DAY = 24 * HOUR;
/** A session credits at most 8h to a day — a laptop left open is not work. */
const CAP = 8 * HOUR;

/**
 * Days still read from the raw rows at query time. Yesterday is included so a
 * rollup that has not run yet (the sweep is hourly) can never leave a hole in
 * the graph; its row is written anyway and takes over the day after.
 */
export const ACTIVITY_LIVE_DAYS = 2;

/** The first ms the live window covers. Days before it come from rollup rows. */
export function activityLiveFrom(now: number): number {
  return dayStartUtc(now) - (ACTIVITY_LIVE_DAYS - 1) * DAY;
}

/** The privacy facts a conversation-sourced interval carries for the viewer gate. */
export type IntervalConversation = {
  user_id: Id<"users">;
  team_id?: Id<"teams">;
  is_private: boolean;
  team_visibility?: string;
  started_at?: number;
};

/** An interval plus the routing team it files under and its privacy facts. */
export type ScopedInterval = ActivityInterval & {
  team_id?: Id<"teams">;
  /** Absent when the source was an event or insight (the conversation is gone). */
  conv?: IntervalConversation;
};

export type ActivityDayRow = {
  day_start: number;
  hours: number[];
  msgs: number[];
  sessions: number[];
  day_sessions: number;
  projects: number;
};

const zeros24 = () => new Array(24).fill(0);

function basenameOf(path?: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || null;
}

/**
 * Every session credited to [from, to) for one user, from all three sources.
 *
 * A session is credited to its LAST activity day (`updated_at`), which is what
 * the heatmap has always shown: "today's hours" means sessions I was working on
 * today, even ones that began earlier in the week.
 *
 * `conversations` wins wherever the row still exists — it carries the real
 * duration, message count, project and privacy, and it decides the credited
 * day — so an event or insight is used only when its conversation is gone
 * (deleted or pruned). That costs one `get` per event, a few hundred per day.
 */
export async function collectIntervalsInWindow(
  ctx: { db: any },
  userId: Id<"users">,
  from: number,
  to: number,
): Promise<ScopedInterval[]> {
  const intervals: ScopedInterval[] = [];
  const seen = new Set<string>();

  const convos = ctx.db
    .query("conversations")
    .withIndex("by_user_updated", (q: any) =>
      q.eq("user_id", userId).gte("updated_at", from).lt("updated_at", to),
    );
  for await (const c of convos) {
    const upd = c.updated_at ?? c.started_at;
    if (!upd) continue;
    seen.add(String(c._id));
    const durMs = c.started_at ? Math.max(0, upd - c.started_at) : 0;
    intervals.push({
      start: upd - durMs,
      end: upd,
      hours: Math.min(durMs, CAP) / HOUR,
      msgs: c.message_count ?? 0,
      project: basenameOf(c.git_root || c.project_path),
      team_id: c.team_id,
      conv: {
        user_id: c.user_id,
        team_id: c.team_id,
        is_private: c.is_private,
        team_visibility: c.team_visibility,
        started_at: c.started_at,
      },
    });
  }

  // A conversation this window does not own (it was updated on another day)
  // still owns its session everywhere, so the fallback sources must skip it.
  const conversationLives = async (id: Id<"conversations"> | undefined) => {
    if (!id) return false;
    if (seen.has(String(id))) return true;
    const row = await ctx.db.get(id);
    if (row) seen.add(String(id));
    return !!row;
  };

  const events: Doc<"team_activity_events">[] = await ctx.db
    .query("team_activity_events")
    .withIndex("by_actor_timestamp", (q: any) =>
      q.eq("actor_user_id", userId).gte("timestamp", from).lt("timestamp", to),
    )
    .collect();

  // `session_completed` first: the record carrying duration + message_count
  // should win the dedupe over the bare `session_started` of the same session.
  const passes = [
    events.filter((e) => e.event_type === "session_completed"),
    events.filter((e) => e.event_type === "session_started"),
  ];
  for (const pass of passes) {
    for (const e of pass) {
      const cid = e.related_conversation_id ? String(e.related_conversation_id) : `evt-${e._id}`;
      if (seen.has(cid)) continue;
      if (await conversationLives(e.related_conversation_id)) continue;
      seen.add(cid);
      const durMs = e.event_type === "session_completed" ? (e.metadata as any)?.duration_ms : undefined;
      intervals.push({
        start: e.timestamp - (durMs ?? 0.5 * HOUR),
        end: e.timestamp,
        hours: durMs ? Math.min(durMs, CAP) / HOUR : 0.5,
        msgs: (e.metadata as any)?.message_count ?? 0,
        team_id: e.team_id,
      });
    }
  }

  const insights: Doc<"session_insights">[] = await ctx.db
    .query("session_insights")
    .withIndex("by_actor_generated_at", (q: any) =>
      q.eq("actor_user_id", userId).gte("generated_at", from).lt("generated_at", to),
    )
    .collect();
  for (const ins of insights) {
    const cid = String(ins.conversation_id);
    if (seen.has(cid)) continue;
    if (await conversationLives(ins.conversation_id)) continue;
    seen.add(cid);
    intervals.push({
      start: ins.generated_at - 0.5 * HOUR,
      end: ins.generated_at,
      hours: 0.5,
      msgs: 0,
      team_id: ins.team_id,
    });
  }

  return intervals;
}

type DayAcc = {
  hours: number[];
  msgs: number[];
  sessions: number[];
  day_sessions: number;
  projects: Set<string>;
};

const emptyAcc = (): DayAcc => ({
  hours: zeros24(),
  msgs: zeros24(),
  sessions: zeros24(),
  day_sessions: 0,
  projects: new Set<string>(),
});

/**
 * Spread one session's credit across the UTC hours of the day it is credited
 * to. The interval is clamped to that day, so a day's row is self-contained
 * and re-rolling one day can never change another day's row.
 */
function addInterval(acc: DayAcc, iv: ScopedInterval, dayStart: number): void {
  const end = Math.max(dayStart, Math.min(iv.end, dayStart + DAY - 1));
  const start = Math.max(dayStart, Math.min(iv.start, end));
  const span = end - start;
  const firstHour = Math.floor((start - dayStart) / HOUR);
  const lastHour = Math.floor((end - dayStart) / HOUR);
  for (let h = firstHour; h <= lastHour; h++) {
    const cellStart = dayStart + h * HOUR;
    const frac = span <= 0 ? 1 : (Math.min(end, cellStart + HOUR) - Math.max(start, cellStart)) / span;
    if (frac <= 0) continue;
    acc.hours[h] += iv.hours * frac;
    acc.msgs[h] += iv.msgs * frac;
    acc.sessions[h]++;
  }
  acc.day_sessions++;
  if (iv.project) acc.projects.add(iv.project);
}

function rowFields(total: DayAcc, shared: DayAcc) {
  const round = (a: number[], p: number) => a.map((v) => Math.round(v * p) / p);
  return {
    hours: round(total.hours, 1000),
    msgs: round(total.msgs, 100),
    sessions: total.sessions,
    day_sessions: total.day_sessions,
    projects: total.projects.size,
    shared_hours: round(shared.hours, 1000),
    shared_msgs: round(shared.msgs, 100),
    shared_sessions: shared.sessions,
    shared_day_sessions: shared.day_sessions,
    shared_projects: shared.projects.size,
    updated_at: Date.now(),
  };
}

/**
 * Recompute one user's rows for one UTC day from the raw sources. Idempotent:
 * it overwrites every row of that day and deletes the ones the day no longer
 * has, so a re-run after a late transcript sync corrects the day.
 */
export async function rollupActivityDay(
  ctx: { db: any },
  userId: Id<"users">,
  dayStart: number,
): Promise<{ rows: number; sessions: number }> {
  const intervals = await collectIntervalsInWindow(ctx, userId, dayStart, dayStart + DAY);

  // One filter per team the day touched: a teammate sees only what the owner
  // shares with that team, and the shared counters are that view, pre-summed.
  const filters = new Map<string, (conv: any) => boolean>();
  const sharedFor = async (teamId: Id<"teams"> | undefined) => {
    if (!teamId) return () => false; // no team scope → no teammate can read it
    const key = String(teamId);
    let f = filters.get(key);
    if (!f) {
      const filter = await createTeamFeedFilter(ctx as any, teamId);
      f = (conv: any) => filter.isVisible(conv);
      filters.set(key, f);
    }
    return f;
  };

  type Slot = { team_id?: Id<"teams">; total: DayAcc; shared: DayAcc };
  const slots = new Map<string, Slot>();
  for (const iv of intervals) {
    if (dayStartUtc(iv.end) !== dayStart) continue;
    const key = iv.team_id ? String(iv.team_id) : "";
    const slot = slots.get(key) ?? { team_id: iv.team_id, total: emptyAcc(), shared: emptyAcc() };
    slots.set(key, slot);
    addInterval(slot.total, iv, dayStart);
    const isShared = iv.conv ? (await sharedFor(iv.team_id))(iv.conv) : !!iv.team_id;
    if (isShared) addInterval(slot.shared, iv, dayStart);
  }

  const existing = await ctx.db
    .query("user_activity_daily")
    .withIndex("by_user_day", (q: any) => q.eq("user_id", userId).eq("day_start", dayStart))
    .collect();
  const byKey = new Map<string, any>(existing.map((r: any) => [r.team_id ? String(r.team_id) : "", r]));

  let sessions = 0;
  for (const [key, slot] of slots) {
    sessions += slot.total.day_sessions;
    const fields = rowFields(slot.total, slot.shared);
    const row = byKey.get(key);
    if (row) await ctx.db.patch(row._id, fields);
    else
      await ctx.db.insert("user_activity_daily", {
        user_id: userId,
        team_id: slot.team_id,
        day_start: dayStart,
        ...fields,
      });
  }
  for (const [key, row] of byKey) {
    if (!slots.has(key)) await ctx.db.delete(row._id);
  }
  return { rows: slots.size, sessions };
}

/** Which counter set a reader gets: the owner's own and the public graph see
 *  the totals, a teammate sees only what the owner shares with the team. */
export type ActivityScope = "total" | "shared";

/**
 * One user's rolled-up days over [from, to), optionally scoped to one team. An
 * unscoped read sums every team's row for a day — the same rule the send and
 * usage counters follow.
 */
export async function fetchUserActivityDays(
  ctx: { db: any },
  userId: Id<"users">,
  teamId: Id<"teams"> | undefined,
  from: number,
  to: number,
  scope: ActivityScope = "total",
): Promise<ActivityDayRow[]> {
  const rows: any[] = teamId
    ? await ctx.db
        .query("user_activity_daily")
        .withIndex("by_user_team_day", (q: any) =>
          q.eq("user_id", userId).eq("team_id", teamId).gte("day_start", from).lt("day_start", to),
        )
        .collect()
    : await ctx.db
        .query("user_activity_daily")
        .withIndex("by_user_day", (q: any) =>
          q.eq("user_id", userId).gte("day_start", from).lt("day_start", to),
        )
        .collect();

  const pick = (r: any): ActivityDayRow =>
    scope === "shared"
      ? {
          day_start: r.day_start,
          hours: r.shared_hours,
          msgs: r.shared_msgs,
          sessions: r.shared_sessions,
          day_sessions: r.shared_day_sessions,
          projects: r.shared_projects ?? 0,
        }
      : {
          day_start: r.day_start,
          hours: r.hours,
          msgs: r.msgs,
          sessions: r.sessions,
          day_sessions: r.day_sessions,
          projects: r.projects ?? 0,
        };

  const byDay = new Map<number, ActivityDayRow>();
  for (const raw of rows) {
    const r = pick(raw);
    const acc =
      byDay.get(r.day_start) ??
      ({ day_start: r.day_start, hours: zeros24(), msgs: zeros24(), sessions: zeros24(), day_sessions: 0, projects: 0 } as ActivityDayRow);
    byDay.set(r.day_start, {
      day_start: r.day_start,
      hours: acc.hours.map((v, h) => v + (r.hours[h] || 0)),
      msgs: acc.msgs.map((v, h) => v + (r.msgs[h] || 0)),
      sessions: acc.sessions.map((v, h) => v + (r.sessions[h] || 0)),
      day_sessions: acc.day_sessions + r.day_sessions,
      projects: acc.projects + r.projects,
    });
  }
  return [...byDay.values()].sort((a, b) => a.day_start - b.day_start);
}

export { DAY as ACTIVITY_DAY_MS };
