// The Changes dirty scheduler (docs/proposals/changes-page.md 7.7, 8.4). A
// write that changes what a team day's edition would say marks that day dirty;
// the first mark schedules one rebuildDay (changesSchedule.ts) and later marks
// ride it, so a burst of 45 commits costs one rebuild. A page view never marks
// anything, so it never spends tokens.
//
// Every hook here is called from a hot write path (commit inserts, insight
// upserts, visibility patches, external events), so with the team's flag off
// each one costs a team read and stops. The one exception is the privacy
// reset: a story built from a session that the team may no longer read loses
// its prose in the same transaction, flag or no flag, because the rows were
// written while it was on.
//
// A leaf: nothing here imports ./functions, so lib/access.ts, teams.ts and
// externalEvents.ts can call it without a load cycle (convex/moduleLoad.test.ts).

import type { Scheduler } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { isoWeekOf, sliceDek, statsHeadline } from "@codecast/shared/changes";
import { teamHasFeature } from "./teamFeatureGuard";
import { addDays, dayBounds, localDate, teamTimezone } from "./teamDay";
import { isHarnessScratch, normalizeRepository } from "./gitRefs";
import { teamVisibleInputs } from "./changesAccess";

/** A mutation's ctx. The scheduler is optional only so helpers typed `{ db }`
 *  can pass theirs through; every real mutation has one. A mark without a
 *  scheduler leaves an unscheduled row that the reconcile cron picks up. */
export type DirtyCtx = { db: any; scheduler?: Scheduler };

/** A mark's rebuild runs this long after the first mark (spec 7.7). */
export const REBUILD_DELAY_MS = 10 * 60_000;
/** A privacy reset shows interim text until layer 0 runs, so its rebuild comes sooner. */
export const INVALIDATE_DELAY_MS = 30_000;
/** A dirty row with no pending run this old is a rebuild that died; the reconcile reschedules it. */
export const STRANDED_MS = 30 * 60_000;
/** Days the 6-hour reconcile looks back over, today included. */
export const RECONCILE_DAYS = 3;
/** Days marked when a team turns Changes on, today included, and the spacing between them. */
export const BACKFILL_DAYS = 14;
export const BACKFILL_SPACING_MS = 5_000;
/** A ship carries stories from up to this many days before it (changes.ts reads ships this far ahead). */
export const SHIP_LOOKAHEAD_DAYS = 3;
/** Until this long after a team-local midnight, a rebuild of today rebuilds yesterday too. */
export const YESTERDAY_GRACE_MS = 3 * 60 * 60_000;

/** Story inputs one transaction resets for a member: the hook's own share, then each scheduled page. Each one
 *  reads its conversation and insight (with turns), so few keep the visibility change under the 1s cap. */
export const MEMBER_PAGE = 50;
/** A session's commits read to find the days a widening reaches. Commit rows can carry patches, so few. */
const SESSION_COMMITS = 20;

export type DayKey = { team_id: Id<"teams">; repository: string; date: string };

// The zone a team's day is cut in, or null with the flag off. Memoized per
// transaction (keyed on its db) so a push of 45 commits resolves it once.
const zones = new WeakMap<object, Map<string, Promise<string | null>>>();

export function changesZone(ctx: { db: any }, teamId: Id<"teams"> | null | undefined): Promise<string | null> {
  if (!teamId) return Promise.resolve(null);
  let byTeam = zones.get(ctx.db);
  if (!byTeam) zones.set(ctx.db, (byTeam = new Map()));
  let zone = byTeam.get(String(teamId));
  if (!zone) {
    zone = (async () => ((await teamHasFeature(ctx, teamId, "changes")) ? teamTimezone(ctx, teamId) : null))();
    byTeam.set(String(teamId), zone);
  }
  return zone;
}

async function dirtyRow(ctx: { db: any }, key: DayKey): Promise<Doc<"change_dirty"> | null> {
  return await ctx.db
    .query("change_dirty")
    .withIndex("by_key", (q: any) => q.eq("team_id", key.team_id).eq("repository", key.repository).eq("date", key.date))
    .first();
}

/** The row's scheduled rebuild while it has not started. */
async function pendingRun(ctx: { db: any }, row: Doc<"change_dirty"> | null): Promise<{ scheduledTime: number } | null> {
  if (!row?.scheduled_id) return null;
  const job = await ctx.db.system.get(row.scheduled_id);
  return job?.state?.kind === "pending" ? job : null;
}

/**
 * Mark one team day dirty. A pending rebuild that fires within `delay` covers
 * the mark; a later one is moved up. A rebuild already running has read its
 * commits, so a mark during it schedules another. The caller has checked the
 * team's flag.
 */
export async function markDayDirty(ctx: DirtyCtx, key: DayKey, delay = REBUILD_DELAY_MS): Promise<void> {
  const now = Date.now();
  const row = await dirtyRow(ctx, key);
  const pending = await pendingRun(ctx, row);
  if (pending && (pending.scheduledTime <= now + delay || !ctx.scheduler)) return;
  if (pending) await ctx.scheduler!.cancel(row!.scheduled_id!);
  const scheduled_id: Id<"_scheduled_functions"> | undefined = ctx.scheduler
    ? await ctx.scheduler.runAfter(delay, internal.changesSchedule.rebuildDay, key)
    : undefined;
  // A row with no pending run was claimed by a rebuild (or its run died), so it
  // is dirty again from now.
  if (!row) await ctx.db.insert("change_dirty", { ...key, since: now, scheduled_id });
  else await ctx.db.patch(row._id, pending ? { scheduled_id } : { scheduled_id, since: now });
}

/** Mark the team-local day containing `timestamp` dirty. A no-op unless the team has Changes on. */
export async function markChangesDirty(
  ctx: DirtyCtx,
  teamId: Id<"teams"> | null | undefined,
  repository: string | null | undefined,
  timestamp: number,
  delay = REBUILD_DELAY_MS,
): Promise<boolean> {
  if (!repository) return false;
  const zone = await changesZone(ctx, teamId);
  if (!zone) return false;
  await markDayDirty(ctx, { team_id: teamId!, repository: normalizeRepository(repository), date: localDate(timestamp, zone) }, delay);
  return true;
}

/** A commit row was inserted, or learned its session or files: its day is dirty. */
export async function markCommitDirty(ctx: DirtyCtx, commitId: Id<"commits">): Promise<void> {
  const commit: Doc<"commits"> | null = await ctx.db.get(commitId);
  if (!commit || isHarnessScratch({ branch: commit.branch })) return;
  await markChangesDirty(ctx, commit.team_id, commit.repository, commit.timestamp);
}

/** Whether the repository has a day edition for `date`: a day with commits once built. */
async function hasEdition(ctx: { db: any }, key: DayKey): Promise<boolean> {
  const row = await ctx.db
    .query("digests")
    .withIndex("by_team_repo_scope_date", (q: any) =>
      q.eq("team_id", key.team_id).eq("repository", key.repository).eq("scope", "day").eq("date", key.date))
    .first();
  return !!row;
}

/**
 * An external event was recorded. A merged pull request joins the stories of
 * the day it merged. A release or a deploy also says what carried the stories
 * of the days before it, so those days are marked too when they have an
 * edition.
 */
export async function markEventDirty(
  ctx: DirtyCtx,
  event: { team_id?: Id<"teams">; repository?: string; kind: string; created_at: number },
): Promise<void> {
  if (event.kind === "pr_merged") {
    await markChangesDirty(ctx, event.team_id, event.repository, event.created_at);
    return;
  }
  if (event.kind !== "release" && event.kind !== "deploy") return;
  if (!event.repository) return;
  const zone = await changesZone(ctx, event.team_id);
  if (!zone) return;
  const day = localDate(event.created_at, zone);
  const repository = normalizeRepository(event.repository);
  for (let back = 0; back <= SHIP_LOOKAHEAD_DAYS; back++) {
    const key = { team_id: event.team_id!, repository, date: addDays(day, -back) };
    if (back === 0 || (await hasEdition(ctx, key))) await markDayDirty(ctx, key);
  }
}

async function inputsOfConversation(ctx: { db: any }, conversationId: Id<"conversations">): Promise<Doc<"change_story_inputs">[]> {
  return await ctx.db
    .query("change_story_inputs")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .take(200);
}

/** Mark the days of the given stories dirty, for teams with the flag on. */
async function markStoryDays(ctx: DirtyCtx, storyIds: Iterable<Id<"change_stories">>, delay = REBUILD_DELAY_MS): Promise<void> {
  const seen = new Set<string>();
  for (const id of new Set([...storyIds].map(String))) {
    const story: Doc<"change_stories"> | null = await ctx.db.get(id as Id<"change_stories">);
    if (!story || !(await changesZone(ctx, story.team_id))) continue;
    const key = { team_id: story.team_id, repository: story.repository, date: story.date };
    const k = `${key.team_id}|${key.repository}|${key.date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    await markDayDirty(ctx, key, delay);
  }
}

/** A session's insight was written for a team: that team's stories it feeds take the new inputs. Another
 *  team's stories withhold the insight (changesAccess), so they have nothing to rebuild. */
export async function markInsightDirty(
  ctx: DirtyCtx,
  conversationId: Id<"conversations">,
  teamId: Id<"teams"> | null | undefined,
): Promise<void> {
  if (!(await changesZone(ctx, teamId))) return;
  const rows = await inputsOfConversation(ctx, conversationId);
  const ours = rows.filter((r) => String(r.team_id) === String(teamId));
  if (ours.length) await markStoryDays(ctx, ours.map((r) => r.story_id));
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * The day and week editions holding the story go back to their stats line
 * until prose runs again. The week also drops its editor's pick of stories,
 * which was made reading the withdrawn text; the heaviest five lead until the
 * week is rebuilt (changesWeek.ts).
 */
async function resetEditions(ctx: { db: any }, story: Doc<"change_stories">): Promise<void> {
  for (const [scope, date] of [["day", story.date], ["week", isoWeekOf(story.date)]] as const) {
    const edition: Doc<"digests"> | null = await ctx.db
      .query("digests")
      .withIndex("by_team_repo_scope_date", (q: any) =>
        q.eq("team_id", story.team_id).eq("repository", story.repository).eq("scope", scope).eq("date", date))
      .first();
    if (!edition || (edition.status !== "written" && edition.status !== "final")) continue;
    await ctx.db.patch(edition._id, {
      headline: statsHeadline(edition.stats ?? { commits: 0, stories: 0, releases: 0 }),
      narrative: "",
      status: "facts",
      inputs_hash: undefined,
      top_story_keys: undefined,
    });
  }
}

/**
 * Story inputs whose session the team may no longer read, or now reads at
 * `summary` where the story was built at `full`, are withdrawn in this
 * transaction: the input row goes (or narrows), the story drops the session,
 * and its prose and its day and week editions' prose fall back to facts. The
 * text written from the session is gone before any rebuild runs; layer 0
 * restores the subject-based text when it does. Returns the stories it reset.
 */
export async function withdrawNarrowedInputs(ctx: DirtyCtx, rows: Doc<"change_story_inputs">[]): Promise<Id<"change_stories">[]> {
  const byTeam = new Map<string, Doc<"change_story_inputs">[]>();
  for (const row of rows) byTeam.set(String(row.team_id), [...(byTeam.get(String(row.team_id)) ?? []), row]);

  const stories = new Set<string>();
  for (const [teamId, teamRows] of byTeam) {
    const gate = await teamVisibleInputs(ctx, teamId as Id<"teams">, teamRows.map((r) => r.conversation_id));
    for (const row of teamRows) {
      const now = gate.get(String(row.conversation_id));
      if (now && !(now.mode === "summary" && (row.mode ?? "full") === "full")) continue;
      if (now) await ctx.db.patch(row._id, { mode: "summary" });
      else await ctx.db.delete(row._id);
      stories.add(String(row.story_id));
    }
  }

  const reset: Id<"change_stories">[] = [];
  for (const id of stories) {
    const story: Doc<"change_stories"> | null = await ctx.db.get(id as Id<"change_stories">);
    if (!story) continue;
    const left: Doc<"change_story_inputs">[] = await ctx.db
      .query("change_story_inputs")
      .withIndex("by_story", (q: any) => q.eq("story_id", story._id))
      .collect();
    const keep = new Set(left.map((r) => String(r.conversation_id)));
    await ctx.db.patch(story._id, {
      conversation_ids: story.conversation_ids.filter((c) => keep.has(String(c))),
      actor_user_ids: [...new Map(left.map((r) => [String(r.owner_id), r.owner_id])).values()],
      prose_status: "pending",
      body: undefined,
      why_source: undefined,
      risk_lines: undefined,
      // Prose replaced layer 0's text and layer 0's is not stored, so the
      // interim text is built from the row's own facts.
      ...(story.why_source !== undefined
        ? { headline: `${plural(story.commit_shas.length, "commit")} in ${story.area}`, dek: sliceDek(story.area_counts) }
        : {}),
    });
    await resetEditions(ctx, story);
    reset.push(story._id);
  }
  return reset;
}

/**
 * A session's visibility changed (lib/access.patchConversationVisibility).
 * Stories it fed lose what it may no longer give, now. Then the days it
 * reaches are marked: the days of its stories, and, for a team with Changes
 * on, the days of its commits, where a session that just became visible
 * joins.
 */
export async function invalidateForConversation(
  ctx: DirtyCtx,
  conversation: { _id: Id<"conversations">; team_id?: Id<"teams"> },
): Promise<void> {
  const rows = await inputsOfConversation(ctx, conversation._id);
  if (rows.length) {
    const reset = new Set((await withdrawAndMark(ctx, rows)).map(String));
    await markStoryDays(ctx, rows.map((r) => r.story_id).filter((id) => !reset.has(String(id))));
  }
  if (!(await changesZone(ctx, conversation.team_id))) return;
  const commits: Doc<"commits">[] = await ctx.db
    .query("commits")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversation._id))
    .order("desc")
    .take(SESSION_COMMITS);
  for (const c of commits) {
    if (!isHarnessScratch({ branch: c.branch })) await markChangesDirty(ctx, c.team_id, c.repository, c.timestamp);
  }
}

/** Withdraw what `rows` may no longer give, and rebuild the reset stories' days soon. */
export async function withdrawAndMark(ctx: DirtyCtx, rows: Doc<"change_story_inputs">[]): Promise<Id<"change_stories">[]> {
  const reset = await withdrawNarrowedInputs(ctx, rows);
  await markStoryDays(ctx, reset, INVALIDATE_DELAY_MS);
  return reset;
}

/**
 * A member's level fell or their membership ended (teams.endMembership): their
 * sessions' contributions narrow at once, the first page here and the rest in
 * scheduled pages.
 */
export async function withdrawMember(ctx: DirtyCtx, ownerId: Id<"users">, teamId: Id<"teams">): Promise<void> {
  const rows: Doc<"change_story_inputs">[] = await ctx.db
    .query("change_story_inputs")
    .withIndex("by_owner", (q: any) => q.eq("owner_id", ownerId).eq("team_id", teamId))
    .take(MEMBER_PAGE + 1);
  await withdrawAndMark(ctx, rows.slice(0, MEMBER_PAGE));
  // The rest continue in pages (changesSchedule.invalidateForMember), from the start: rows already handled no longer narrow.
  if (rows.length > MEMBER_PAGE && ctx.scheduler) {
    await ctx.scheduler.runAfter(0, internal.changesSchedule.invalidateForMember, { owner_id: ownerId, team_id: teamId, cursor: null });
  }
}

/**
 * A member's team visibility level changed (teams.applyMembershipVisibilityChange).
 * Their sessions' contributions narrow at once. With Changes on, the team's
 * editions of the last two weeks are marked too, since a raised level lets
 * past sessions join stories they were kept out of.
 */
export async function invalidateForMember(ctx: DirtyCtx, ownerId: Id<"users">, teamId: Id<"teams">): Promise<void> {
  await withdrawMember(ctx, ownerId, teamId);

  const zone = await changesZone(ctx, teamId);
  if (!zone) return;
  const from = addDays(localDate(Date.now(), zone), -(BACKFILL_DAYS - 1));
  const editions: Doc<"digests">[] = await ctx.db
    .query("digests")
    .withIndex("by_team_scope_date", (q: any) => q.eq("team_id", teamId).eq("scope", "day").gte("date", from))
    .take(500);
  for (const e of editions) {
    if (e.repository && !e.user_id) await markDayDirty(ctx, { team_id: teamId, repository: e.repository, date: e.date });
  }
}

/** A team's features changed (teamFeatures.ts): turning Changes on backfills the last two weeks. */
export async function changesFlagChanged(
  ctx: DirtyCtx,
  teamId: Id<"teams">,
  before: { changes?: boolean } | null | undefined,
  after: { changes?: boolean } | null | undefined,
): Promise<void> {
  if (!before?.changes && after?.changes && ctx.scheduler) {
    await ctx.scheduler.runAfter(0, internal.changesSchedule.backfill, { team_id: teamId });
  }
}

/** What a rebuild of `key` covers: the day, and yesterday too in the first hours after midnight. */
export function rebuildDates(date: string, zone: string, now: number): string[] {
  const today = localDate(now, zone);
  if (date !== today || now - dayBounds(today, zone).start >= YESTERDAY_GRACE_MS) return [date];
  return [date, addDays(today, -1)];
}

/** A rebuild starts: it owns the marks made so far. Marks during it schedule the next one. */
export async function claimDirtyDay(ctx: DirtyCtx, key: DayKey): Promise<string | null> {
  const zone = await changesZone(ctx, key.team_id);
  const row = await dirtyRow(ctx, key);
  if (!zone) {
    if (row) await ctx.db.delete(row._id);
    return null;
  }
  if (row?.scheduled_id) await ctx.db.patch(row._id, { scheduled_id: undefined });
  return zone;
}

/** A rebuild finished: the row goes unless a mark during it scheduled another. */
export async function finishDirtyDay(ctx: DirtyCtx, key: DayKey): Promise<void> {
  const row = await dirtyRow(ctx, key);
  if (row && !(await pendingRun(ctx, row))) await ctx.db.delete(row._id);
}

/** Rows whose rebuild died (no pending run for a while) are scheduled again; rows of teams with the flag off go. */
export async function rescheduleStranded(ctx: DirtyCtx, now: number): Promise<number> {
  const rows: Doc<"change_dirty">[] = await ctx.db.query("change_dirty").take(2000);
  let rescheduled = 0;
  for (const row of rows) {
    if (now - row.since < STRANDED_MS || (await pendingRun(ctx, row))) continue;
    if (!(await changesZone(ctx, row.team_id))) {
      await ctx.db.delete(row._id);
      continue;
    }
    await markDayDirty(ctx, { team_id: row.team_id, repository: row.repository, date: row.date }, BACKFILL_SPACING_MS * rescheduled);
    rescheduled += 1;
  }
  return rescheduled;
}
