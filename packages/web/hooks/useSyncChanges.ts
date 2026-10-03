// The Changes timeline (docs/proposals/changes-page.md 8.3): feeders that
// bring a team's stories, editions, live surfaces and In the works into the
// store, and readers the page paints from.
//
// The timeline is today back as far as the reader has scrolled, fed in
// chunks of TIMELINE_CHUNK_DAYS days. Each chunk is its own subscription, so
// a flooded week (a Littlebird week is well over the 600 stories one call
// serves) stops short inside its own chunk and never starves the rest. The
// first chunk is fed by the hook; older chunks are ChangesChunkFeed elements
// the page mounts as it reaches them.
//
// Editions are upserted per day and never deleted, so their feeds only add.
// One more editions feed reads every repository's last 14 days, so the
// repository list and the default repository settle at once, and one reads
// the week editions the timeline's week dividers show.
//
// The live line and In the works are per repository too, and each answer is
// the whole of its repository: what it lacks there has stopped, and what
// another repository holds stays cached, so a return paints at once. Their
// row ids are composed, never Convex ids, so the drop reaches disk and plants
// no tombstone: a surface or a session that comes back shows again.
//
// Readers subscribe to signatures of the fields the page renders. Story rows
// change only when a rebuild writes them, so the lists stay still between
// rebuilds whatever else moves in the store.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { EditionRow, LiveRow, StoryRow, StorySessionRow, WorksRow } from "@codecast/convex/convex/changesQueries";
import { addDays } from "@codecast/convex/convex/lib/teamDay";
import { isoWeekOf } from "@codecast/shared/changes";
import { normalizeRepository } from "@codecast/shared/contracts";
import { useCallback, useMemo } from "react";
import { isConvexId } from "../store/inboxStore";
import type { SyncOpts } from "../store/inboxStore";
import { useCollectionRows } from "./useCollectionRows";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { byTimestampDesc } from "./useSyncTimeline";

const api = _api as any;

export type { EditionRow, LiveRow, StoryRow, StorySessionRow, WorksRow };

export type DateWindow = { from_date: string; to_date: string };

/** Days in one timeline chunk: one subscription each. */
export const TIMELINE_CHUNK_DAYS = 7;

/** The timeline's chunk `k`, counting back from today: chunk 0 ends today. */
export function timelineChunk(today: string, k: number): DateWindow {
  const to = addDays(today, -k * TIMELINE_CHUNK_DAYS);
  return { from_date: addDays(to, -(TIMELINE_CHUNK_DAYS - 1)), to_date: to };
}

/** Days back from today whose editions name the team's active repositories (spec 4.1). */
export const CHANGES_REPO_DAYS = 14;

/** The last CHANGES_REPO_DAYS days ending today. */
export function recentWindow(today: string): DateWindow {
  return { from_date: addDays(today, -(CHANGES_REPO_DAYS - 1)), to_date: today };
}

/** The repository as the server stores it, so store rows compare equal. */
const canonical = (repository: string | undefined) => (repository ? normalizeRepository(repository) : undefined);

type TeamScope = { teamId: string; repository?: string };

const inTeamRepo = (row: { team_id?: unknown; repository?: string }, scope: TeamScope) =>
  String(row.team_id) === scope.teamId && (!scope.repository || row.repository === scope.repository);

/**
 * The sync opts for one listStories answer. The answer is every story in
 * [covered_from, to_date] for the team (and repository, when one was asked
 * for), so a cached story in that range that the answer lacks was deleted by a
 * rebuild and is pruned. A read that stopped short of the window reports how
 * far back it is whole, and a read that covered no whole day prunes nothing.
 *
 * `except` is a day another feed owns. The prune leaves a permanent tombstone,
 * so a day fed by two subscriptions is pruned by only one of them: an older
 * answer from the other could otherwise bury a story the newer one just added.
 */
export function storySyncOpts(scope: TeamScope, window: DateWindow, except?: string): (data: any) => SyncOpts | undefined {
  return (data) => {
    const from: string | null | undefined = data?.covered_from;
    if (!from) return undefined;
    return {
      pruneAbsentScope: (row: any) =>
        inTeamRepo(row, scope) && row.date >= from && row.date <= window.to_date && row.date !== except,
    };
  };
}

/**
 * The live strip's answer is every surface of one repository in the team: a
 * cached surface of that repository it lacks has gone, and every other
 * repository's surfaces stay cached for a return to them.
 */
export const liveScope = (scope: TeamScope) => (row: LiveRow) => String(row.team_id) === scope.teamId && row.repository === scope.repository;

/**
 * In the works answers for one repository, or the whole team: its session
 * rows name the repository they were read for, and its reviews and branches
 * name their own. A cached row the answer covers and lacks has stopped
 * moving; another repository's rows stay cached for a return to it.
 */
export const worksScope = (scope: TeamScope) => (row: WorksRow) => {
  if (String(row.team_id) !== scope.teamId) return false;
  const repo = row.repository ? normalizeRepository(row.repository) : undefined;
  if (row.kind === "stuck" || row.kind === "building") return repo === scope.repository;
  return !scope.repository || repo === scope.repository;
};

/** listStories answers `{ stories, covered_from, complete }`, or null when it refused the caller (nothing synced). */
export const selectStories = (data: any): StoryRow[] | undefined => (data && Array.isArray(data.stories) ? data.stories : undefined);

export type TimelineView = {
  teamId: string | undefined;
  /** One repository, or every repository of the team. */
  repository?: string;
  /** The team's today, YYYY-MM-DD in its day. */
  today: string;
  /** Chunks on screen, newest first: the week dividers' editions cover them all. */
  chunks: number;
};

export type ChangesFeedState = {
  /** The newest chunk's stories and editions have answered. With rows in the
   *  store, `false` is the ordinary paint-from-cache state. */
  ready: boolean;
  /** The server refused the caller: not a member, signed out, or Changes is off for the team. */
  refused: boolean;
  /** The team-wide recent editions have answered. */
  recentReady: boolean;
  error?: Error;
};

const validTeam = (teamId: string | undefined) => (teamId && isConvexId(teamId) ? teamId : undefined);

/** One chunk's story and day edition subscriptions. */
function useChunkFeed(teamId: string | undefined, repository: string | undefined, window: DateWindow | null) {
  const team = validTeam(teamId);
  const repo = canonical(repository);
  const feed = useMemo(() => {
    if (!team || !window) return null;
    const repoArg = repo ? { repository: repo } : {};
    return {
      stories: { args: { team_id: team, ...repoArg, ...window }, opts: { select: selectStories, syncOpts: storySyncOpts({ teamId: team, repository: repo }, window) } },
      editions: { team_id: team, ...repoArg, scope: "day", ...window },
    } as const;
  }, [team, repo, window?.from_date, window?.to_date]);
  const stories = useSyncCollection("changeStories", api.changesQueries.listStories, feed?.stories.args ?? "skip", feed?.stories.opts);
  const editions = useSyncCollection("changeEditions", api.changesQueries.listEditions, feed?.editions ?? "skip");
  return { stories, editions };
}

/** An older chunk of the timeline, mounted as the reader scrolls to it. Renders nothing. */
export function ChangesChunkFeed({ teamId, repository, today, k }: { teamId: string | undefined; repository?: string; today: string; k: number }) {
  const window = useMemo(() => timelineChunk(today, k), [today, k]);
  useChunkFeed(teamId, repository, window);
  return null;
}

/**
 * The timeline's page-level feeds: its newest chunk, the week editions of
 * every chunk on screen, the recent editions behind the repository list, the
 * live line and In the works. The live line needs a repository; without one
 * it is skipped.
 */
export function useSyncChangesTimeline(view: TimelineView): ChangesFeedState {
  const teamId = validTeam(view.teamId);
  const repository = canonical(view.repository);
  const { today, chunks } = view;
  const newest = useMemo(() => timelineChunk(today, 0), [today]);
  const head = useChunkFeed(teamId, repository, newest);

  const feeds = useMemo(() => {
    if (!teamId) return null;
    const scope = { teamId, repository };
    const repoArg = repository ? { repository } : {};
    const oldest = timelineChunk(today, Math.max(0, chunks - 1)).from_date;
    return {
      recent: { team_id: teamId, scope: "day", ...recentWindow(today) },
      weeks: { team_id: teamId, ...repoArg, scope: "week", from_date: isoWeekOf(oldest), to_date: isoWeekOf(today) },
      live: repository ? { args: { team_id: teamId, repository }, opts: { dropAbsent: liveScope(scope) } } : null,
      works: { args: { team_id: teamId, ...repoArg }, opts: { dropAbsent: worksScope(scope) } },
    } as const;
  }, [teamId, repository, today, chunks]);

  const recent = useSyncCollection("changeEditions", api.changesQueries.listEditions, feeds?.recent ?? "skip");
  const weeks = useSyncCollection("changeEditions", api.changesQueries.listEditions, feeds?.weeks ?? "skip");
  const live = useSyncCollection("changeLive", api.changesQueries.liveStatus, feeds?.live?.args ?? "skip", feeds?.live?.opts);
  const works = useSyncCollection("changeWorks", api.changesQueries.inTheWorks, feeds?.works.args ?? "skip", feeds?.works.opts);

  return {
    ready: head.stories.ready && head.editions.ready,
    refused: head.stories.refused || head.editions.refused,
    recentReady: recent.ready,
    error: head.stories.error ?? head.editions.error ?? recent.error ?? weeks.error ?? live.error ?? works.error,
  };
}

/** A story's commits into the `commits` collection, for its evidence drawer. */
export function useSyncStoryEvidence(storyId: string | undefined) {
  return useSyncCollection("commits", api.changesQueries.storyEvidence, entityIdArgs("story_id", storyId));
}

/** Rows of one story's sessions: each storySessions answer is the story's whole
 *  visible set, so a cached row it lacks (a session made private, an owner who
 *  narrowed or left) is dropped from memory and disk. Not pruneAbsentScope,
 *  whose tombstone would keep the session out for good once shared again. */
export const storySessionsScope = (storyId: string) => (row: StorySessionRow) => String(row.story_id) === storyId;

/** The sessions behind a story (headline and gated turns) into `changeStorySessions`, for its evidence drawer. */
export function useSyncStorySessions(storyId: string | undefined) {
  const opts = useMemo(() => (storyId ? { dropAbsent: storySessionsScope(storyId) } : undefined), [storyId]);
  return useSyncCollection("changeStorySessions", api.changesQueries.storySessions, entityIdArgs("story_id", storyId), opts);
}

// ── Readers ──────────────────────────────────────────────────────────────

const storySig = (s: StoryRow) =>
  [
    s.story_key, s.headline, s.dek, s.body ?? "", s.importance, s.prose_status, s.why_source ?? "", s.generated_at ?? "",
    s.kind, s.area, s.branch, s.on_default_branch ? 1 : 0, s.commit_shas.length, s.insertions, s.deletions, s.last_at,
    s.release ? `${s.release.surface}@${s.release.version ?? s.release.sha}` : "",
    s.risks.map((r) => `${r.code}:${r.evidence.join(",")}`).join(";"), JSON.stringify(s.risk_lines ?? null), JSON.stringify(s.area_counts),
    s.conversation_ids.join(","), s.actor_user_ids.join(","), s.author_names.join(","), s.pr_ids.join(","),
    s.private_session_count,
  ].join("|");

const editionSig = (e: EditionRow) =>
  [
    e.headline ?? "", e.status ?? "", e.inputs_hash ?? "", e.narrative, e.lead_story_key ?? "", e.generated_at,
    (e.section_order ?? []).join(","), (e.brief_story_keys ?? []).join(","), JSON.stringify(e.stats ?? null),
    (e.releases ?? []).map((r) => `${r.surface}@${r.version ?? r.sha}`).join(","), e.dirty_since ?? "",
    (e.top_story_keys ?? []).join(","), JSON.stringify(e.area_totals ?? null), e.capped_at ?? "",
  ].join("|");

const liveSig = (l: LiveRow) => `${l.version ?? ""}|${l.sha}|${l.at}|${l.kind}|${l.waiting}|${l.waiting_exact ? 1 : 0}`;

const worksSig = (w: WorksRow) =>
  w.kind === "review"
    ? `${w.title}|${w.draft ? 1 : 0}|${w.checks_state ?? ""}|${w.review_decision ?? ""}|${w.updated_at}`
    : w.kind === "branch"
      ? `${w.commits}|${w.stories}|${w.top_area}|${w.last_at}`
      : `${w.headline}|${w.at}`;

/** Newest day first, then the edition's ranking inputs: importance, then size. */
const storySessionSig = (r: StorySessionRow) => `${r.headline ?? ""}|${r.summary ?? ""}|${JSON.stringify(r.turns)}`;

const byDayThenWeight = (a: StoryRow, b: StoryRow) =>
  b.date.localeCompare(a.date) ||
  b.importance - a.importance ||
  (b.insertions + b.deletions) - (a.insertions + a.deletions) ||
  a.story_key.localeCompare(b.story_key);

const byDateDesc = (a: EditionRow, b: EditionRow) => b.date.localeCompare(a.date);
const bySurface = (a: LiveRow, b: LiveRow) => a.surface.localeCompare(b.surface);

/** The column's group order (spec 4.7), then newest first inside a group. */
const WORKS_GROUP: Record<WorksRow["kind"], number> = { stuck: 0, building: 1, review: 2, branch: 3 };
const worksAt = (w: WorksRow) => (w.kind === "review" ? w.updated_at : w.kind === "branch" ? w.last_at : w.at);
const byWorksGroup = (a: WorksRow, b: WorksRow) =>
  WORKS_GROUP[a.kind] - WORKS_GROUP[b.kind] || worksAt(b) - worksAt(a) || a._id.localeCompare(b._id);

/** The team's stories in [from, to] (one repository, or all), newest day first. */
export function useChangeStories(teamId: string | undefined, repository: string | undefined, window: DateWindow | undefined): StoryRow[] {
  const repo = canonical(repository);
  const where = useCallback(
    (s: StoryRow) => !!teamId && !!window && inTeamRepo(s, { teamId, repository: repo }) && s.date >= window.from_date && s.date <= window.to_date,
    [teamId, repo, window?.from_date, window?.to_date],
  );
  return useCollectionRows<StoryRow>("changeStories", { where, sig: storySig, sort: byDayThenWeight });
}

/** The team's editions of a scope in [from, to] (one repository, or all), newest first. */
export function useChangeEditions(
  teamId: string | undefined,
  repository: string | undefined,
  window: DateWindow | undefined,
  scope: "day" | "week" = "day",
): EditionRow[] {
  const repo = canonical(repository);
  const where = useCallback(
    (e: EditionRow) =>
      !!teamId && !!window && inTeamRepo(e, { teamId, repository: repo }) && e.scope === scope && e.date >= window.from_date && e.date <= window.to_date,
    [teamId, repo, scope, window?.from_date, window?.to_date],
  );
  return useCollectionRows<EditionRow>("changeEditions", { where, sig: editionSig, sort: byDateDesc });
}

/** The live strip: one row per surface of the repository, by surface name. */
export function useChangeLive(teamId: string | undefined, repository: string | undefined): LiveRow[] {
  const repo = canonical(repository);
  const where = useCallback((l: LiveRow) => !!teamId && !!repo && String(l.team_id) === teamId && l.repository === repo, [teamId, repo]);
  return useCollectionRows<LiveRow>("changeLive", { where, sig: liveSig, sort: bySurface });
}

/** In the works for the team: stuck, building, in review, then branches, each newest first. */
export function useChangeWorks(teamId: string | undefined): WorksRow[] {
  const where = useCallback((w: WorksRow) => !!teamId && String(w.team_id) === teamId, [teamId]);
  return useCollectionRows<WorksRow>("changeWorks", { where, sig: worksSig, sort: byWorksGroup });
}

/** The sessions behind a story, in the story's own order. Only ids the story
 *  still names are read, so a session the gate dropped at the last rebuild
 *  leaves the drawer even while its cached row lingers. */
export function useStorySessions(story: Pick<StoryRow, "_id" | "conversation_ids"> | undefined): StorySessionRow[] {
  const storyId = story ? String(story._id) : "";
  const ids = story?.conversation_ids.map(String).join(",") ?? "";
  const { where, sort } = useMemo(() => {
    const order = new Map((ids ? ids.split(",") : []).map((id, i) => [id, i]));
    return {
      where: (r: StorySessionRow) => String(r.story_id) === storyId && order.has(String(r.conversation_id)),
      sort: (a: StorySessionRow, b: StorySessionRow) => order.get(String(a.conversation_id))! - order.get(String(b.conversation_id))!,
    };
  }, [storyId, ids]);
  return useCollectionRows<StorySessionRow>("changeStorySessions", { where, sig: storySessionSig, sort });
}

// The drawer paints far more of a commit than the timeline lane does (its
// diffstat, files, joins and author), so it wakes on its own signature.
const evidenceSig = (c: any) =>
  [
    c.message, c.timestamp, c.pr_number ?? "", c.conversation_id ?? "", c.insertions ?? "", c.deletions ?? "",
    c.files_changed ?? "", (c.files ?? []).length, (c.task_ids ?? []).join(","), c.author_name ?? "",
  ].join("|");

type StoryCommitScope = Pick<StoryRow, "commit_shas" | "repository" | "team_id">;

/**
 * Whether a commit row is one of a story's: one of its shas, in the story's
 * repository and team. A sha alone is not enough, since the `commits`
 * collection holds rows of every repository and team the viewer reads. The
 * server joins the same way (changesQueries).
 */
export function storyCommitMatcher(story: StoryCommitScope): (c: any) => boolean {
  const wanted = new Set(story.commit_shas);
  const repository = normalizeRepository(story.repository);
  const team = String(story.team_id);
  return (c) => !!c && wanted.has(c.sha) && String(c.team_id) === team && normalizeRepository(c.repository ?? "") === repository;
}

/** One row per sha, the newest written (a commit synced twice), in the order given. */
export function newestBySha<T extends { sha: string; _creationTime?: number }>(rows: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const had = best.get(r.sha);
    if (!had || (r._creationTime ?? 0) > (had._creationTime ?? 0)) best.set(r.sha, r);
  }
  return rows.filter((r) => best.get(r.sha) === r);
}

/** A story's commit rows out of any set of commit rows, one per sha, newest first. */
export const storyCommits = (story: StoryCommitScope, rows: Iterable<any>): any[] =>
  newestBySha([...rows].filter(storyCommitMatcher(story)).sort(byTimestampDesc));

/** The story's commit rows from the `commits` collection, one per sha, newest first. */
export function useStoryEvidence(story: StoryCommitScope | undefined): any[] {
  const key = story ? `${String(story.team_id)}|${story.repository}|${story.commit_shas.join(",")}` : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key is the story's team, repository and shas
  const where = useMemo(() => (story ? storyCommitMatcher(story) : () => false), [key]);
  const rows = useCollectionRows<any>("commits", { where, sig: evidenceSig, sort: byTimestampDesc });
  return useMemo(() => newestBySha(rows), [rows]);
}
