// The Changes page (docs/proposals/changes-page.md 8.3): feeders that bring a
// team's stories, editions, live surfaces and In the works into the store, and
// readers the page paints from.
//
// Every feed is per view (the team, repository and day on screen), so none of
// them gates on the sync host. Stories and editions are fed for a 7 day window
// around the viewed day, so `[` and `]` paint from cache; the viewed day also
// gets a subscription of its own, because a flooded window (a Littlebird week
// is well over the 600 stories one call serves) stops short from the newest
// day back and could leave the viewed day out.
//
// Readers subscribe to signatures of the fields the page renders. Story rows
// change only when a rebuild writes them, so the lists stay still between
// rebuilds whatever else moves in the store.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { EditionRow, LiveRow, StoryRow, WorksRow } from "@codecast/convex/convex/changesQueries";
import { addDays } from "@codecast/convex/convex/lib/teamDay";
import { normalizeRepository } from "@codecast/shared/contracts";
import { useCallback, useMemo } from "react";
import { isConvexId } from "../store/inboxStore";
import type { SyncOpts } from "../store/inboxStore";
import { useCollectionRows } from "./useCollectionRows";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { useCommits } from "./useSyncTimeline";

const api = _api as any;

export type { EditionRow, LiveRow, StoryRow, WorksRow };

/** Days fed on each side of the viewed day. */
export const CHANGES_WINDOW_RADIUS = 3;

export type DateWindow = { from_date: string; to_date: string };

/** The fed window around a YYYY-MM-DD day. */
export function changesWindow(date: string): DateWindow {
  return { from_date: addDays(date, -CHANGES_WINDOW_RADIUS), to_date: addDays(date, CHANGES_WINDOW_RADIUS) };
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
 */
export function storySyncOpts(scope: TeamScope, window: DateWindow): (data: any) => SyncOpts | undefined {
  return (data) => {
    const from: string | null | undefined = data?.covered_from;
    if (!from) return undefined;
    return {
      pruneAbsentScope: (row: any) => inTeamRepo(row, scope) && row.date >= from && row.date <= window.to_date,
    };
  };
}

/** listStories answers `{ stories, covered_from, complete }`, or null when it refused the caller (nothing synced). */
export const selectStories = (data: any): StoryRow[] | undefined => (data && Array.isArray(data.stories) ? data.stories : undefined);

/** listEditions answers every edition of the scope in the window, so a cached one it lacks is gone. */
export function editionSyncOpts(scope: TeamScope, editionScope: "day" | "week", window: DateWindow): SyncOpts {
  return {
    pruneAbsentScope: (row: any) =>
      inTeamRepo(row, scope) && row.scope === editionScope && row.date >= window.from_date && row.date <= window.to_date,
  };
}

export type ChangesView = {
  teamId: string | undefined;
  /** One repository, or every repository of the team. */
  repository?: string;
  /** The viewed day, YYYY-MM-DD in the team's day. */
  date: string | undefined;
};

export type ChangesFeedState = {
  /** The viewed day's stories and the window's editions have answered. With
   *  rows in the store, `false` is the ordinary paint-from-cache state. */
  ready: boolean;
  /** The server refused the caller: not a member, signed out, or Changes is off for the team. */
  refused: boolean;
  error?: Error;
};

/**
 * Mount every feed of the Changes page for the viewed team, repository and
 * day. The live strip needs a repository; without one it is skipped.
 */
export function useSyncChanges(view: ChangesView): ChangesFeedState {
  const teamId = view.teamId && isConvexId(view.teamId) ? view.teamId : undefined;
  const repository = canonical(view.repository);
  const date = view.date;

  const feeds = useMemo(() => {
    if (!teamId || !date) return null;
    const scope = { teamId, repository };
    const repoArg = repository ? { repository } : {};
    const day = { from_date: date, to_date: date };
    const around = changesWindow(date);
    return {
      day: {
        args: { team_id: teamId, ...repoArg, ...day },
        opts: { select: selectStories, syncOpts: storySyncOpts(scope, day) },
      },
      around: {
        args: { team_id: teamId, ...repoArg, ...around },
        opts: { select: selectStories, syncOpts: storySyncOpts(scope, around) },
      },
      editions: {
        args: { team_id: teamId, ...repoArg, scope: "day", ...around },
        opts: { syncOpts: editionSyncOpts(scope, "day", around) },
      },
      live: repository ? { team_id: teamId, repository } : "skip",
      works: { team_id: teamId, ...repoArg },
    } as const;
  }, [teamId, repository, date]);

  const day = useSyncCollection("changeStories", api.changesQueries.listStories, feeds?.day.args ?? "skip", feeds?.day.opts);
  const around = useSyncCollection("changeStories", api.changesQueries.listStories, feeds?.around.args ?? "skip", feeds?.around.opts);
  const editions = useSyncCollection("changeEditions", api.changesQueries.listEditions, feeds?.editions.args ?? "skip", feeds?.editions.opts);
  const live = useSyncCollection("changeLive", api.changesQueries.liveStatus, feeds?.live ?? "skip");
  const works = useSyncCollection("changeWorks", api.changesQueries.inTheWorks, feeds?.works ?? "skip");

  return {
    ready: day.ready && editions.ready,
    refused: day.refused || editions.refused,
    error: day.error ?? editions.error ?? around.error ?? live.error ?? works.error,
  };
}

/** A story's commits into the `commits` collection, for its evidence drawer. */
export function useSyncStoryEvidence(storyId: string | undefined) {
  return useSyncCollection("commits", api.changesQueries.storyEvidence, entityIdArgs("story_id", storyId));
}

// ── Readers ──────────────────────────────────────────────────────────────

const storySig = (s: StoryRow) =>
  [
    s.story_key, s.headline, s.dek, s.body ?? "", s.importance, s.prose_status, s.why_source ?? "", s.generated_at ?? "",
    s.kind, s.area, s.branch, s.on_default_branch ? 1 : 0, s.commit_shas.length, s.insertions, s.deletions, s.last_at,
    s.release ? `${s.release.surface}@${s.release.version ?? s.release.sha}` : "",
    s.risks.map((r) => r.code).join(","), JSON.stringify(s.risk_lines ?? null),
    s.conversation_ids.join(","), s.actor_user_ids.join(","), s.author_names.join(","), s.pr_ids.join(","),
    s.private_session_count,
  ].join("|");

const editionSig = (e: EditionRow) =>
  [
    e.headline ?? "", e.status ?? "", e.inputs_hash ?? "", e.narrative, e.lead_story_key ?? "", e.generated_at,
    (e.section_order ?? []).join(","), (e.brief_story_keys ?? []).join(","), JSON.stringify(e.stats ?? null),
    (e.releases ?? []).map((r) => `${r.surface}@${r.version ?? r.sha}`).join(","), e.dirty_since ?? "",
  ].join("|");

const liveSig = (l: LiveRow) => `${l.version ?? ""}|${l.sha}|${l.at}|${l.kind}|${l.waiting}|${l.waiting_exact ? 1 : 0}`;

const worksSig = (w: WorksRow) =>
  w.kind === "review"
    ? `${w.title}|${w.draft ? 1 : 0}|${w.checks_state ?? ""}|${w.review_decision ?? ""}|${w.updated_at}`
    : w.kind === "branch"
      ? `${w.commits}|${w.stories}|${w.top_area}|${w.last_at}`
      : `${w.headline}|${w.at}`;

/** Newest day first, then the edition's ranking inputs: importance, then size. */
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

/** The story's commit rows from the `commits` collection, newest first. */
export function useStoryEvidence(story: Pick<StoryRow, "commit_shas"> | undefined): any[] {
  const shas = story?.commit_shas.join(",") ?? "";
  const where = useMemo(() => {
    const wanted = new Set(shas ? shas.split(",") : []);
    return (c: any) => wanted.has(c.sha);
  }, [shas]);
  return useCommits(where);
}
