// The public reads behind the Changes page (docs/proposals/changes-page.md
// 8.2). Each one feeds a store collection, so each answers `null` when the
// caller may not read the team (signed out, not a member, Changes off for the
// team): a feeder reads `null` as refused and keeps its cache, where a throw
// would surface as an error on every subscription.
//
// Stories and editions are team-only rows (no `workspace` key): nothing
// private was ever written into them, so membership is the whole grant. The
// two reads that reach past them go through the existing gates: commits
// through canAccessCommit, insights through teamVisibleInputs().
//
// Every read is a team-scoped index window with a cap, never a global index:
// a Littlebird-sized team (760 commits a day) stays well under 1 MiB a call.

import { v } from "convex/values";
import { query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { isoWeekOf, latestShips, waitingStories, weekMonday, withoutShadowedReleases, type ShipEvent } from "@codecast/shared/changes";
import { getUserOrToken } from "./lib/auth";
import { isTeamMember } from "./lib/access";
import { teamHasFeature } from "./lib/teamFeatureGuard";
import { teamVisibleInputs, teamVisibleRecentInsights, type TeamVisibleInput } from "./lib/changesAccess";
import { sessionImages } from "./lib/sessionMedia";
import { addDays, localDate, teamTimezone } from "./lib/teamDay";
import { normalizeRepository, prUrl } from "./lib/gitRefs";
import { accessibleCommits } from "./commits";
import { shipOf } from "./changes";

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A dirty day older than this reads as stale: the page shows its quiet "summarizing" dot (spec 7.7). */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** The widest story window one call serves, in days. */
const STORY_WINDOW_DAYS = 31;
/** Stories per call, and the bytes they may read. A Littlebird day is about 170 stories and 170 KB. */
const STORY_PAGE = 600;
const STORY_PAGE_BYTES = 768 * 1024;
/** Editions are one small row per day and scope. */
const EDITION_WINDOW_DAYS = 120;
/** Week editions one read may return. */
const EDITION_WINDOW_WEEKS = 20;
/** A surface exists when it shipped in this window (spec 7.3). */
const SURFACE_WINDOW_DAYS = 30;
/** Recent ship events read directly, ahead of the next rebuild folding them into an edition. */
const SHIP_EVENT_SCAN = 300;
/** Stories read to count a surface's waiting work, newest first. */
const WAITING_SCAN = 400;
/** In the works (spec 4.7). */
const WORKS_INSIGHT_WINDOW_MS = 48 * 60 * 60 * 1000;
const WORKS_INSIGHT_SCAN = 100;
const WORKS_PER_GROUP = 8;
// A session in progress shows its latest screenshots from the last day.
const WORKS_SHOTS = 3;
const WORKS_SHOTS_WINDOW_MS = DAY_MS;
const WORKS_PR_EVENT_WINDOW_MS = 14 * DAY_MS;
const WORKS_PR_EVENT_SCAN = 300;
const WORKS_PR_READS = 10;
const WORKS_PRS = 6;
const WORKS_BRANCH_STORY_SCAN = 500;
const WORKS_BRANCHES = 12;
/** Commits one evidence drawer serves. */
const EVIDENCE_COMMITS = 60;

type Ctx = { db: any; auth: any };

/**
 * The caller, when they may read this team's Changes: signed in (session or
 * CLI token), a member of the team, and the team has the feature on. Null
 * otherwise, and every query answers null with it.
 */
export async function changesReader(ctx: Ctx, teamId: Id<"teams">, apiToken?: string): Promise<Id<"users"> | null> {
  const userId = await getUserOrToken(ctx, apiToken);
  if (!userId) return null;
  if (!(await isTeamMember(ctx, userId, teamId))) return null;
  if (!(await teamHasFeature(ctx, teamId, "changes"))) return null;
  return userId;
}

/** A from/to pair of YYYY-MM-DD, ordered and clamped to `maxDays`, or null when malformed. */
export function dateWindow(from: string, to: string, maxDays: number): { from: string; to: string } | null {
  if (!DATE.test(from) || !DATE.test(to)) return null;
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const floor = addDays(hi, -(maxDays - 1));
  return { from: lo < floor ? floor : lo, to: hi };
}

/** A from/to pair of ISO weeks (`2026-W40`), ordered and clamped to `maxWeeks`, or null when malformed. */
export function weekWindow(from: string, to: string, maxWeeks: number): { from: string; to: string } | null {
  if (!weekMonday(from) || !weekMonday(to)) return null;
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const floor = isoWeekOf(addDays(weekMonday(hi)!, -7 * (maxWeeks - 1)));
  return { from: lo < floor ? floor : lo, to: hi };
}

const repositoryOf = (repository: string | undefined) => (repository ? normalizeRepository(repository) : undefined);

// ── Stories ──────────────────────────────────────────────────────────────

/** A story as the page reads it: the stored row without its generation accounting. */
export type StoryRow = Omit<Doc<"change_stories">, "inputs_hash" | "model" | "input_tokens" | "output_tokens" | "cost_usd" | "cap_version" | "cap_cost_usd">;

function storyRow(row: Doc<"change_stories">): StoryRow {
  const { inputs_hash: _h, model: _m, input_tokens: _i, output_tokens: _o, cost_usd: _c, cap_version: _v, cap_cost_usd: _cc, ...rest } = row;
  return rest;
}

/**
 * The team's stories in [from_date, to_date], newest day first. A delta feed:
 * the store keeps what earlier windows brought. One call reads at most
 * STORY_PAGE rows and STORY_PAGE_BYTES, so a flooded window comes back short:
 * `covered_from` is then the oldest date whose stories are all here (the day
 * the read stopped in may be partial), and a caller wanting older days asks
 * again with to_date before it.
 */
export const listStories = query({
  args: {
    team_id: v.id("teams"),
    repository: v.optional(v.string()),
    from_date: v.string(),
    to_date: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ stories: StoryRow[]; covered_from: string | null; complete: boolean } | null> => {
    if (!(await changesReader(ctx, args.team_id, args.api_token))) return null;
    const window = dateWindow(args.from_date, args.to_date, STORY_WINDOW_DAYS);
    if (!window) return { stories: [], covered_from: null, complete: true };
    const repository = repositoryOf(args.repository);
    const range = repository
      ? ctx.db.query("change_stories").withIndex("by_team_repo_date", (q) =>
          q.eq("team_id", args.team_id).eq("repository", repository).gte("date", window.from).lte("date", window.to))
      : ctx.db.query("change_stories").withIndex("by_team_date", (q) =>
          q.eq("team_id", args.team_id).gte("date", window.from).lte("date", window.to));
    const page = await range.order("desc").paginate({ numItems: STORY_PAGE, cursor: null, maximumBytesRead: STORY_PAGE_BYTES });
    const rows: Doc<"change_stories">[] = page.page;
    if (page.isDone) return { stories: rows.map(storyRow), covered_from: window.from, complete: true };
    // The read stopped inside the oldest date it reached; the day after it is the last whole one.
    const reached = rows.length ? rows[rows.length - 1].date : window.to;
    const coveredFrom = addDays(reached, 1);
    return { stories: rows.map(storyRow), covered_from: coveredFrom <= window.to ? coveredFrom : null, complete: false };
  },
});

// ── Editions ─────────────────────────────────────────────────────────────

export type EditionRow = Omit<Doc<"digests">, "user_id" | "events" | "model" | "input_tokens" | "output_tokens" | "cost_usd" | "cap_version" | "cap_cost_usd" | "scheduled_id"> & {
  /** When the day was first marked for a rebuild that has not run yet, else null. */
  dirty_since: number | null;
  /** dirty_since is older than STALE_AFTER_MS as of this read. The time moves on without a new read, so a page holding the row compares dirty_since itself. */
  stale: boolean;
};

/**
 * The team's editions of one scope in [from_date, to_date], each with its
 * rebuild state from change_dirty. Personal digests share the table and are
 * never served here.
 */
export const listEditions = query({
  args: {
    team_id: v.id("teams"),
    repository: v.optional(v.string()),
    scope: v.union(v.literal("day"), v.literal("week")),
    from_date: v.string(),
    to_date: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<EditionRow[] | null> => {
    if (!(await changesReader(ctx, args.team_id, args.api_token))) return null;
    // Day editions are keyed by day, week editions by ISO week.
    const window = args.scope === "week"
      ? weekWindow(args.from_date, args.to_date, EDITION_WINDOW_WEEKS)
      : dateWindow(args.from_date, args.to_date, EDITION_WINDOW_DAYS);
    if (!window) return [];
    const repository = repositoryOf(args.repository);
    const rows: Doc<"digests">[] = repository
      ? await ctx.db.query("digests").withIndex("by_team_repo_scope_date", (q) =>
          q.eq("team_id", args.team_id).eq("repository", repository).eq("scope", args.scope).gte("date", window.from).lte("date", window.to))
          .take(EDITION_WINDOW_DAYS * 4)
      : await ctx.db.query("digests").withIndex("by_team_scope_date", (q) =>
          q.eq("team_id", args.team_id).eq("scope", args.scope).gte("date", window.from).lte("date", window.to))
          .take(EDITION_WINDOW_DAYS * 4);
    const now = Date.now();
    return await Promise.all(rows.filter((d) => !d.user_id && d.repository).map(async (d) => {
      const dirty: Doc<"change_dirty"> | null = await ctx.db
        .query("change_dirty")
        .withIndex("by_key", (q) => q.eq("team_id", args.team_id).eq("repository", d.repository!).eq("date", d.date))
        .first();
      const { user_id: _u, events: _e, model: _m, input_tokens: _i, output_tokens: _o, cost_usd: _c, cap_version: _v, cap_cost_usd: _cc, scheduled_id: _s, ...rest } = d;
      return { ...rest, dirty_since: dirty?.since ?? null, stale: !!dirty && now - dirty.since > STALE_AFTER_MS };
    }));
  },
});

// ── Live status ──────────────────────────────────────────────────────────

export type LiveRow = {
  /** One row per surface of a repository in a team. */
  _id: string;
  team_id: Id<"teams">;
  repository: string;
  surface: string;
  version?: string;
  sha: string;
  at: number;
  kind: ShipEvent["kind"];
  /** Default-branch stories in this surface's areas that landed after the ship. */
  waiting: number;
  /** False when the count stopped at WAITING_SCAN stories and is a floor. */
  waiting_exact: boolean;
};

/**
 * Per surface, the latest ship in the last 30 days and how many stories wait
 * behind it. Ships come from two places: each day edition's `releases` (what
 * buildDay saw: tags, deploy markers and release commits), and the newest
 * ship events directly, so a deploy shows before the rebuild it triggered has
 * run. An edition stores no kind, so a ship known only from an edition reads
 * as a release when it names a version (release commits and tags always do)
 * and as a deploy otherwise.
 */
export const liveStatus = query({
  args: { team_id: v.id("teams"), repository: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<LiveRow[] | null> => {
    if (!(await changesReader(ctx, args.team_id, args.api_token))) return null;
    const repository = normalizeRepository(args.repository);
    const zone = await teamTimezone(ctx, args.team_id);
    const now = Date.now();
    const since = now - SURFACE_WINDOW_DAYS * DAY_MS;

    const editions: Doc<"digests">[] = await ctx.db
      .query("digests")
      .withIndex("by_team_repo_scope_date", (q) =>
        q.eq("team_id", args.team_id).eq("repository", repository).eq("scope", "day").gte("date", localDate(since, zone)))
      .take(SURFACE_WINDOW_DAYS + 2);
    const events: Doc<"external_events">[] = await ctx.db
      .query("external_events")
      .withIndex("by_repository_created", (q) => q.eq("repository", repository).gte("created_at", since))
      .order("desc")
      .take(SHIP_EVENT_SCAN);

    const ships = new Map<string, ShipEvent>();
    for (const e of events) {
      const ship = String(e.team_id) === String(args.team_id) ? shipOf(e) : null;
      if (ship) ships.set(`${ship.surface}|${ship.sha}`, ship);
    }
    for (const d of editions) {
      for (const r of d.releases ?? []) {
        const key = `${r.surface}|${r.sha}`;
        if (!ships.has(key)) ships.set(key, { ...r, kind: r.version ? "release" : "deploy" });
      }
    }
    const latest = Object.values(latestShips(withoutShadowedReleases([...ships.values()]).filter((s) => s.at >= since)));
    if (!latest.length) return [];

    // Stories from the oldest latest-ship's day forward, newest first.
    const oldest = localDate(Math.min(...latest.map((s) => s.at)), zone);
    const stories: Doc<"change_stories">[] = await ctx.db
      .query("change_stories")
      .withIndex("by_team_repo_date", (q) => q.eq("team_id", args.team_id).eq("repository", repository).gte("date", oldest))
      .order("desc")
      .take(WAITING_SCAN);
    const capped = stories.length === WAITING_SCAN;
    const reached = stories.length ? stories[stories.length - 1].date : oldest;

    return latest
      .sort((a, b) => a.surface.localeCompare(b.surface))
      .map((ship) => ({
        _id: `${args.team_id}|${repository}|${ship.surface}`,
        team_id: args.team_id,
        repository,
        surface: ship.surface,
        ...(ship.version ? { version: ship.version } : {}),
        sha: ship.sha,
        at: ship.at,
        kind: ship.kind,
        waiting: waitingStories(stories, ship).length,
        // Every day after the one the scan stopped in was read whole.
        waiting_exact: !capped || localDate(ship.at, zone) > reached,
      }));
  },
});

// ── Story evidence ───────────────────────────────────────────────────────

/**
 * The story's commit rows, newest first, each through canAccessCommit. They
 * feed the `commits` collection the /commit page reads, so the rows go out
 * whole, exactly as that page's own feeds send them.
 */
export const storyEvidence = query({
  args: { story_id: v.id("change_stories"), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Doc<"commits">[] | null> => {
    const story = await ctx.db.get(args.story_id);
    if (!story) return null;
    const userId = await changesReader(ctx, story.team_id, args.api_token);
    if (!userId) return null;
    const repository = normalizeRepository(story.repository);
    const found = await Promise.all(story.commit_shas.slice(0, EVIDENCE_COMMITS).map(async (sha) => {
      const rows: Doc<"commits">[] = await ctx.db.query("commits").withIndex("by_sha", (q) => q.eq("sha", sha)).take(5);
      return rows.find((c) => String(c.team_id) === String(story.team_id) && normalizeRepository(c.repository ?? "") === repository) ?? null;
    }));
    const commits = found.filter((c): c is Doc<"commits"> => !!c).sort((a, b) => b.timestamp - a.timestamp);
    return await accessibleCommits(ctx, userId, commits);
  },
});

// ── In the works ─────────────────────────────────────────────────────────

export type WorksRow =
  | {
      _id: string;
      team_id: Id<"teams">;
      kind: "stuck" | "building";
      conversation_id: Id<"conversations">;
      /** The repository the session ran in, on a repository's read; absent on a team-wide one. */
      repository?: string;
      headline: string;
      outcome_type: "blocked" | "progress";
      at: number;
      /** The session's latest screenshots, for a session the team sees in full. */
      shots?: string[];
    }
  | {
      _id: string;
      team_id: Id<"teams">;
      kind: "review";
      pr_id: Id<"pull_requests">;
      repository: string;
      number: number;
      title: string;
      url: string;
      draft: boolean;
      checks_state: string | null;
      review_decision: string | null;
      head_ref: string | null;
      author_github_username: string;
      updated_at: number;
    }
  | {
      _id: string;
      team_id: Id<"teams">;
      kind: "branch";
      repository: string;
      branch: string;
      commits: number;
      stories: number;
      top_area: string;
      last_at: number;
    };

/** Whether any of this team's stories on the default branch was built from this session: its work has landed. */
async function hasLanded(ctx: Ctx, teamId: Id<"teams">, conversationId: Id<"conversations">): Promise<boolean> {
  const inputs: Doc<"change_story_inputs">[] = await ctx.db
    .query("change_story_inputs")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .take(20);
  for (const input of inputs) {
    if (String(input.team_id) !== String(teamId)) continue;
    const story: Doc<"change_stories"> | null = await ctx.db.get(input.story_id);
    if (story?.on_default_branch) return true;
  }
  return false;
}

/**
 * The repository a session ran in: its git remote, else its checkout root
 * resolved through the owner's repo_sources (a clone with no remote recorded
 * on the session). Undefined when neither says, and such a session belongs
 * to no repository's page.
 */
async function inputRepository(ctx: Ctx, input: Pick<TeamVisibleInput, "owner_id" | "repository" | "checkout_root">): Promise<string | undefined> {
  if (input.repository) return normalizeRepository(input.repository);
  if (!input.checkout_root) return undefined;
  const source: Doc<"repo_sources"> | null = await ctx.db
    .query("repo_sources")
    .withIndex("by_user_root", (q: any) => q.eq("user_id", input.owner_id).eq("root", input.checkout_root))
    .first();
  return source?.repository ? normalizeRepository(source.repository) : undefined;
}

/** Today's non-default branches: commits (a batch commit split into area slices counts once), stories and the top area. */
function branchRows(teamId: Id<"teams">, stories: readonly Doc<"change_stories">[]): WorksRow[] {
  const byBranch = new Map<string, { repository: string; branch: string; shas: Set<string>; stories: number; areas: Record<string, number>; last_at: number }>();
  for (const s of stories) {
    if (s.on_default_branch) continue;
    const key = `${s.repository}|${s.branch}`;
    const b = byBranch.get(key) ?? { repository: s.repository, branch: s.branch, shas: new Set<string>(), stories: 0, areas: {}, last_at: 0 };
    for (const sha of s.commit_shas) b.shas.add(sha);
    b.stories += 1;
    for (const [area, n] of Object.entries(s.area_counts)) b.areas[area] = (b.areas[area] ?? 0) + n;
    b.last_at = Math.max(b.last_at, s.last_at);
    byBranch.set(key, b);
  }
  return [...byBranch.values()]
    .sort((a, b) => b.shas.size - a.shas.size || b.last_at - a.last_at)
    .slice(0, WORKS_BRANCHES)
    .map((b) => ({
      _id: `branch:${b.repository}|${b.branch}`,
      team_id: teamId,
      kind: "branch" as const,
      repository: b.repository,
      branch: b.branch,
      commits: b.shas.size,
      stories: b.stories,
      top_area: Object.entries(b.areas).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? "",
      last_at: b.last_at,
    }));
}

/**
 * What is still moving (spec 4.7): team-visible insights from the last 48
 * hours that are blocked (stuck) or in progress with nothing landed yet
 * (building), open pull requests, and today's non-default branches. Insights
 * come only through teamVisibleInputs() and carry nothing but a headline, the
 * outcome and the session id; a session the team cannot see, or one whose
 * owner shows the team less than a summary, is absent. Asked for one
 * repository, every group keeps to it: an insight whose session ran
 * elsewhere, or whose repository cannot be told, is left out.
 */
export const inTheWorks = query({
  args: { team_id: v.id("teams"), repository: v.optional(v.string()), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<WorksRow[] | null> => {
    if (!(await changesReader(ctx, args.team_id, args.api_token))) return null;
    const teamId = args.team_id;
    const repository = repositoryOf(args.repository);
    const now = Date.now();
    const out: WorksRow[] = [];

    const insights = await teamVisibleRecentInsights(ctx, teamId, now - WORKS_INSIGHT_WINDOW_MS, WORKS_INSIGHT_SCAN);
    const counts = { stuck: 0, building: 0 };
    for (const input of insights) {
      const outcome = input.insight.outcome_type;
      if (outcome !== "blocked" && outcome !== "progress") continue;
      const kind = outcome === "blocked" ? "stuck" : "building";
      if (counts[kind] >= WORKS_PER_GROUP) continue;
      // A repository's page shows only its own sessions; one whose repository cannot be told is no page's.
      if (repository && (await inputRepository(ctx, input)) !== repository) continue;
      if (kind === "building" && (await hasLanded(ctx, teamId, input.conversation_id))) continue;
      counts[kind] += 1;
      const shots = input.mode === "full" ? (await sessionImages(ctx, input.conversation_id, { since: now - WORKS_SHOTS_WINDOW_MS, max: WORKS_SHOTS })).map((i) => i.url) : [];
      out.push({
        _id: `${kind}:${input.conversation_id}`,
        team_id: teamId,
        kind,
        conversation_id: input.conversation_id,
        ...(repository ? { repository } : {}),
        headline: input.insight.headline || input.insight.summary.slice(0, 160),
        outcome_type: outcome,
        at: input.insight.generated_at,
        ...(shots.length ? { shots } : {}),
      });
    }

    // Open pull requests, found through the team's recent pull request activity.
    const events: Doc<"external_events">[] = await ctx.db
      .query("external_events")
      .withIndex("by_team_source_created", (q) =>
        q.eq("team_id", teamId).eq("source_id", undefined).gte("created_at", now - WORKS_PR_EVENT_WINDOW_MS))
      .order("desc")
      .take(WORKS_PR_EVENT_SCAN);
    const prIds: Id<"pull_requests">[] = [];
    for (const e of events) {
      if (!e.pr_id || prIds.some((id) => String(id) === String(e.pr_id))) continue;
      if (repository && normalizeRepository(e.repository ?? "") !== repository) continue;
      prIds.push(e.pr_id);
      if (prIds.length >= WORKS_PR_READS) break;
    }
    const prs = (await Promise.all(prIds.map((id) => ctx.db.get(id))))
      .filter((pr): pr is Doc<"pull_requests"> => !!pr && pr.state === "open" && String(pr.team_id) === String(teamId))
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, WORKS_PRS);
    for (const pr of prs) {
      out.push({
        _id: `review:${pr._id}`,
        team_id: teamId,
        kind: "review",
        pr_id: pr._id,
        repository: pr.repository,
        number: pr.number,
        title: pr.title,
        url: prUrl(pr.repository, pr.number),
        draft: !!pr.draft,
        checks_state: pr.checks_state ?? null,
        review_decision: pr.review_decision ?? null,
        head_ref: pr.head_ref ?? null,
        author_github_username: pr.author_github_username,
        updated_at: pr.updated_at,
      });
    }

    // Today's branches, from the day's stories (built from the same commits, a fraction of the bytes).
    const today = localDate(now, await teamTimezone(ctx, teamId));
    const stories: Doc<"change_stories">[] = repository
      ? await ctx.db.query("change_stories").withIndex("by_team_repo_date", (q) =>
          q.eq("team_id", teamId).eq("repository", repository).eq("date", today)).take(WORKS_BRANCH_STORY_SCAN)
      : await ctx.db.query("change_stories").withIndex("by_team_date", (q) =>
          q.eq("team_id", teamId).eq("date", today)).take(WORKS_BRANCH_STORY_SCAN);
    out.push(...branchRows(teamId, stories));
    return out;
  },
});

// ── Story sessions ───────────────────────────────────────────────────────

/** Turns one drawer shows per session, and the length of each "did" line, as the story prompt reads them. */
const SESSION_TURNS = 8;
const SESSION_DID_CHARS = 160;

export type StorySessionRow = {
  /** `<story id>|<conversation id>`: one row per session a story drew on. */
  _id: string;
  team_id: Id<"teams">;
  story_id: Id<"change_stories">;
  conversation_id: Id<"conversations">;
  headline: string | null;
  summary: string | null;
  /** The session's asks and what was done for each; only when its owner shares it with the team in full. */
  turns: Array<{ ask: string; did: string[] }>;
};

/**
 * The sessions behind a story for its evidence drawer (spec 3, level 3): each
 * session's insight headline and summary, and its turns as ask/did pairs. The
 * story's sessions passed teamVisibleInputs() when it was built; they pass it
 * again here, so a session made private since, or whose owner now shows the
 * team less, drops out at once, and turns go out only at mode `full`.
 */
export const storySessions = query({
  args: { story_id: v.id("change_stories"), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<StorySessionRow[] | null> => {
    const story = await ctx.db.get(args.story_id);
    if (!story) return null;
    if (!(await changesReader(ctx, story.team_id, args.api_token))) return null;
    const visible = await teamVisibleInputs(ctx, story.team_id, story.conversation_ids);
    return story.conversation_ids.flatMap((id) => {
      const input = visible.get(String(id));
      if (!input) return [];
      const insight = input.insight;
      return [{
        _id: `${story._id}|${id}`,
        team_id: story.team_id,
        story_id: story._id,
        conversation_id: id,
        headline: insight?.headline ?? null,
        summary: insight?.summary || null,
        turns: (insight?.turns ?? []).slice(0, SESSION_TURNS).map((t) => ({
          ask: t.ask,
          did: t.did.map((d) => (d.length > SESSION_DID_CHARS ? `${d.slice(0, SESSION_DID_CHARS - 1)}…` : d)),
        })),
      }];
    });
  },
});
