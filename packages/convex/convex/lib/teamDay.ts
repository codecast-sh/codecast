// The team day: the calendar day a Changes edition covers, cut in one zone
// per team (docs/proposals/changes-page.md 7.6). The zone is teams.timezone
// when set, else the earliest admin's users.timezone, else UTC. A team spread
// across zones gets one edition keyed to that zone.
//
// The date math is @platform/assistant's zone module (DST days are 23 or 25
// hours long, a skipped midnight starts at the first instant that exists),
// re-exported here so the web shares it; this module adds the team's zone.

import type { Id } from "../_generated/dataModel";
import { dayBounds, normalizeTimezone, zonedDay, type ZonedDay } from "@platform/assistant/zone";

export { addDays, dayBounds, localDate, normalizeTimezone, wallClockAt, zonedDay } from "@platform/assistant/zone";

type DbCtx = { db: any };

/** A team-local day: its YYYY-MM-DD and its bounds, `start` inclusive and
 *  `end` exclusive (the next day's start). */
export type TeamDay = ZonedDay;

/** The zone a team's day is cut in: teams.timezone, else the earliest admin
 *  (by joined_at) whose users.timezone names a real zone, else UTC. */
export async function teamTimezone(ctx: DbCtx, teamId: Id<"teams">): Promise<string> {
  const team = await ctx.db.get(teamId);
  if (team?.timezone && normalizeTimezone(team.timezone) === team.timezone) return team.timezone;
  const admins = (await ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
    .collect())
    .filter((m: any) => m.role === "admin")
    .sort((a: any, b: any) => a.joined_at - b.joined_at);
  for (const admin of admins) {
    const zone = (await ctx.db.get(admin.user_id))?.timezone;
    if (zone && normalizeTimezone(zone) === zone) return zone;
  }
  return "UTC";
}

/** The team-local day containing `timestamp`. Each call reads the team and
 *  its memberships; a caller cutting many timestamps for one team resolves
 *  teamTimezone once and passes the zone to zonedDay or dayBounds. */
export async function teamDayFor(ctx: DbCtx, teamId: Id<"teams">, timestamp: number): Promise<TeamDay> {
  return zonedDay(timestamp, await teamTimezone(ctx, teamId));
}

/** The bounds of a team-local `date` (YYYY-MM-DD). */
export async function teamDayBounds(ctx: DbCtx, teamId: Id<"teams">, date: string): Promise<TeamDay> {
  return dayBounds(date, await teamTimezone(ctx, teamId));
}
