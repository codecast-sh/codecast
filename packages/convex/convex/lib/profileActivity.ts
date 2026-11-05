import type { Id } from "../_generated/dataModel";
import { getProfileVisibilityPredicate, isTeamMember } from "../privacy";
import { dayStartUtc } from "./userSend";
import {
  ACTIVITY_DAY_MS,
  activityLiveFrom,
  collectIntervalsInWindow,
  fetchUserActivityDays,
  type ActivityDayRow,
  type ActivityScope,
  type ScopedInterval,
} from "./activityDaily";

// ── Profile activity: rolled-up days + a live window ──
// `user_activity_daily` holds one small row per (user, team, UTC day), so a
// year of activity is ~370 rows instead of the tens of thousands of session
// rows it is derived from (that read blew Convex's system-operation ceiling and
// the profile heatmap failed outright). Only today and yesterday are still
// read raw, where one day is a few hundred documents — see lib/activityDaily.ts.
//
// Who sees what: the owner and the anonymized public graph read the day row's
// totals; a teammate reads its `shared_*` counters, the same team-visibility
// rule `getProfileVisibilityPredicate` applies to the live window. Someone who
// is not the owner and not scoped to a team they share sees nothing.
export type ActivityRequest = { user_id: Id<"users">; team_id?: Id<"teams">; days?: number };

export async function loadUserActivity(
  ctx: any,
  viewerId: Id<"users"> | null,
  args: ActivityRequest,
  opts?: { countAll?: boolean },
): Promise<{ days: ActivityDayRow[]; live: ScopedInterval[] }> {
  const now = Date.now();
  const from = dayStartUtc(now - (args.days ?? 365) * ACTIVITY_DAY_MS);
  const liveFrom = Math.max(activityLiveFrom(now), from);

  const isOwner = !!viewerId && viewerId.toString() === args.user_id.toString();
  const unrestricted = !!opts?.countAll || isOwner;
  // Not the owner: the viewer must be a member of the team they scope to.
  // The day rows are pre-summed, so this gate stands in for the membership
  // half of getProfileVisibilityPredicate, which only sees the live window.
  if (!unrestricted && (!viewerId || !args.team_id || !(await isTeamMember(ctx, viewerId, args.team_id))))
    return { days: [], live: [] };
  const scope: ActivityScope = unrestricted ? "total" : "shared";

  const days = await fetchUserActivityDays(ctx, args.user_id, args.team_id, from, liveFrom, scope);
  const raw = await collectIntervalsInWindow(ctx, args.user_id, liveFrom, now + 1);
  const isVisible = unrestricted
    ? () => true
    : await getProfileVisibilityPredicate(ctx, viewerId!, args.user_id, args.team_id);
  const live = raw
    .filter(
      (iv) =>
        (!args.team_id || String(iv.team_id) === String(args.team_id)) &&
        // An event/insight interval carries no privacy facts (its conversation
        // is gone): it counts for a teammate only as part of a team, exactly as
        // the shared day counters treat it.
        (iv.conv ? isVisible(iv.conv) : unrestricted || !!iv.team_id),
    )
    // A session that began before the live window is credited to its last
    // activity day either way; clamping its start keeps the punchcard from
    // spreading that credit back over days the rolled-up rows already hold.
    .map((iv) => (iv.start < liveFrom ? { ...iv, start: liveFrom } : iv));
  return { days, live };
}

const utcDate = (ts: number) => new Date(ts).toISOString().split("T")[0];

export type DayBucket = { hours: number; sessions: number; msgs: number; projects: Set<string>; projectCount: number };

/** Per-UTC-day totals from the rolled-up rows plus the live window. */
export function bucketActivityDays(days: ActivityDayRow[], live: ScopedInterval[]): Map<string, DayBucket> {
  const buckets = new Map<string, DayBucket>();
  const bucketFor = (date: string) => {
    let b = buckets.get(date);
    if (!b) buckets.set(date, (b = { hours: 0, sessions: 0, msgs: 0, projects: new Set(), projectCount: 0 }));
    return b;
  };
  const sum = (a: number[]) => a.reduce((t, v) => t + v, 0);
  for (const d of days) {
    const b = bucketFor(utcDate(d.day_start));
    b.hours += sum(d.hours);
    b.msgs += sum(d.msgs);
    b.sessions += d.day_sessions;
    b.projectCount += d.projects;
  }
  for (const iv of live) {
    const b = bucketFor(utcDate(iv.end));
    b.hours += iv.hours;
    b.msgs += iv.msgs;
    b.sessions++;
    if (iv.project) b.projects.add(iv.project);
  }
  return buckets;
}
