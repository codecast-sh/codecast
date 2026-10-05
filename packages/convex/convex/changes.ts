// Layer 0 of the Changes page, stored (docs/proposals/changes-page.md 7.1,
// 8.1). buildDay reads one team-local day of a repository's commits through
// small paged internal queries, clusters them with @codecast/shared/changes
// inside the action (so a whole day never meets a query's 1s user-JS or
// 16 MiB caps), and writes one change_stories row per story with its
// deterministic headline and dek.
//
// Sessions enter only through teamVisibleInputs(). A commit whose session
// fails the gate keeps its commit text (team-readable through
// canAccessCommit) and counts toward private_session_count; its session id,
// owner, tasks and pull requests are never written here.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  buildLayerZero,
  inputsHash,
  onDefaultBranch,
  personKey,
  splitMessage,
  statsHeadline,
  summarizeFiles,
  type ChangeCommit,
  type ChangePr,
  type LayerZeroStory,
  type ShipEvent,
  type VisibleConversation,
  clipToSentence,
} from "@codecast/shared/changes";
import { teamVisibleInputs, teamVisibleRecentInsights, type ChangesInputMode } from "./lib/changesAccess";
import { teamDayBounds } from "./lib/teamDay";
import { SHIP_LOOKAHEAD_DAYS } from "./lib/changesDirty";
import { isHarnessScratch, normalizeRepository } from "./lib/gitRefs";
import { canonicalCommandArguments } from "./localFirstCommands";

/** Bumped by the story prompt (changesProse.ts) so every story's inputs_hash moves and prose regenerates. */
export const STORY_PROMPT_VERSION = "story-8";

/** Commits per page (spec 7.1 step 1). A commit someone opened on /commit carries its patches (up to
 *  1 MiB a row), so a page also stops at a byte budget well under the 16 MiB read cap. */
const COMMIT_PAGE = 200;
const COMMIT_PAGE_BYTES = 8 * 1024 * 1024;
/** A commit body as layer 0 keeps it. */
const BODY_CHARS = 600;
/** Conversations per gate read: each costs a conversation, its insight and its pull request links. */
const GATE_CHUNK = 50;
/** Pull request rows carry files and patches (up to 1 MB each), so they are read a few at a time. */
const PR_CHUNK = 8;
/** Commits one author lookup reads. */
const AUTHOR_CHUNK = 40;
/** How long before a commit a session's edits to its files make it an author. */
const AUTHOR_LOOKBACK_MS = 48 * 60 * 60 * 1000;
/** How long after a commit a session's insight may be written: a session's insight is rewritten as it goes on. */
const AUTHOR_LOOKAHEAD_MS = 3 * 24 * 60 * 60 * 1000;
/** Checkouts searched per commit, those with the most sessions at work around it first. */
const AUTHOR_ROOTS = 6;
/** Sessions an author lookup weighs: a past day's, through its lookahead. */
const AUTHOR_CANDIDATES = 400;
/** Authors kept per commit, most files first. */
const AUTHORS_PER_COMMIT = 2;
/** Sessions a story names: its own and its commits' authors together. */
const STORY_SESSIONS = 4;
/** external_events rows per page. */
const EVENT_PAGE = 500;
/** A release the morning after still says what carried the day's stories. */
const SHIP_LOOKAHEAD_MS = SHIP_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;
/** How far back the latest backend deploy is looked for (skew), in pages and in time. */
const DEPLOY_LOOKBACK_PAGES = 4;
const DEPLOY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** Stories per write mutation. */
const WRITE_CHUNK = 40;

const cursorArg = v.union(v.string(), v.null());

// ── Reads ────────────────────────────────────────────────────────────────

/** The team-local bounds of the day and the repository's default branch, when a checkout recorded one. */
export const readDay = internalQuery({
  args: { team_id: v.id("teams"), repository: v.string(), date: v.string() },
  handler: async (ctx, args): Promise<{ start: number; end: number; default_branch: string | null }> => {
    const day = await teamDayBounds(ctx, args.team_id, args.date);
    const sources = await ctx.db
      .query("repo_sources")
      .withIndex("by_repository", (q) => q.eq("repository", normalizeRepository(args.repository)))
      .take(50);
    const recorded = sources.find((s) => String(s.team_id) === String(args.team_id) && s.default_branch);
    return { start: day.start, end: day.end, default_branch: recorded?.default_branch ?? null };
  },
});

/** A commit row as layer 0 reads it (spec 7.1 step 1): files collapsed to areas and the top paths. */
export function projectCommit(c: Doc<"commits">): ChangeCommit {
  const { subject, body } = splitMessage(c.message);
  const files = summarizeFiles(c.files ?? []);
  return {
    sha: c.sha,
    subject,
    ...(body ? { body: clipToSentence(body, BODY_CHARS) } : {}),
    author_name: c.author_name,
    author_email: c.author_email,
    timestamp: c.timestamp,
    created_at: c._creationTime,
    branch: c.branch ?? null,
    conversation_id: c.conversation_id ? String(c.conversation_id) : null,
    task_ids: (c.task_ids ?? []).map(String),
    pr_id: c.pr_id ? String(c.pr_id) : null,
    insertions: c.insertions,
    deletions: c.deletions,
    areas: files.areas,
    subareas: files.subareas,
    top_paths: files.top_paths,
    schema_paths: files.schema_paths,
  };
}

/** One page of the team's commits in [start, end) for one repository. Harness scratch branches are not work. */
export const readCommitsPage = internalQuery({
  args: { team_id: v.id("teams"), repository: v.string(), start: v.number(), end: v.number(), cursor: cursorArg },
  handler: async (ctx, args): Promise<{ commits: ChangeCommit[]; cursor: string; done: boolean }> => {
    const repository = normalizeRepository(args.repository);
    const page = await ctx.db
      .query("commits")
      .withIndex("by_team_timestamp", (q) => q.eq("team_id", args.team_id).gte("timestamp", args.start).lt("timestamp", args.end))
      .paginate({ numItems: COMMIT_PAGE, cursor: args.cursor, maximumBytesRead: COMMIT_PAGE_BYTES });
    const commits = page.page
      .filter((c) => normalizeRepository(c.repository) === repository && !isHarnessScratch({ branch: c.branch }))
      .map(projectCommit);
    return { commits, cursor: page.continueCursor, done: page.isDone };
  },
});

/** A session that passed the gate, reduced to what layer 0 and the inputs hash need. */
export type GateRow = {
  conversation_id: Id<"conversations">;
  owner_id: Id<"users">;
  mode: ChangesInputMode;
  membership_level: string;
  task_ids: string[];
  outcome_type: VisibleConversation["outcome_type"] | null;
  insight: { id: string; generated_at: number } | null;
  pr_ids: Id<"pull_requests">[];
};

/**
 * The sessions that wrote each commit, by its files: a team-visible session
 * that edited one of the commit's paths in the two days before it. In a
 * checkout where one session commits everyone's work, the trailer names the
 * committer, and the story's why, turns and screenshots live in the sessions
 * that typed the change. Commits carry repository-relative paths and edits
 * absolute ones, so each candidate's checkout root joins them. Reads paths,
 * times and session ids only, never an edit's text.
 */
export const readAuthors = internalQuery({
  args: {
    team_id: v.id("teams"),
    repository: v.string(),
    since: v.number(),
    until: v.number(),
    commits: v.array(v.object({ sha: v.string(), timestamp: v.number(), paths: v.array(v.string()) })),
  },
  handler: async (ctx, args): Promise<Record<string, Id<"conversations">[]>> => {
    const repository = normalizeRepository(args.repository);
    const candidates = (await teamVisibleRecentInsights(ctx, args.team_id, args.since, AUTHOR_CANDIDATES, args.until)).filter(
      (c) => !!c.checkout_root && (!c.repository || normalizeRepository(c.repository) === repository),
    );
    const known = new Set(candidates.map((c) => String(c.conversation_id)));
    const out: Record<string, Id<"conversations">[]> = {};
    for (const c of args.commits) {
      // The checkouts of sessions at work around the commit, busiest first.
      const busy = new Map<string, number>();
      for (const s of candidates) {
        if (s.started_at > c.timestamp || s.insight.generated_at < c.timestamp - AUTHOR_LOOKBACK_MS) continue;
        const root = s.checkout_root!.replace(/\/+$/, "");
        busy.set(root, (busy.get(root) ?? 0) + 1);
      }
      const roots = [...busy].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, AUTHOR_ROOTS).map(([root]) => root);
      const score = new Map<string, { id: Id<"conversations">; files: number }>();
      for (const path of c.paths) {
        const hit = new Set<string>();
        for (const root of roots) {
          const rows: Doc<"file_changes">[] = await ctx.db
            .query("file_changes")
            .withIndex("by_file_path", (q) => q.eq("file_path", `${root}/${path}`))
            .order("desc")
            .take(30);
          for (const row of rows) {
            const id = String(row.conversation_id);
            if (row.timestamp > c.timestamp || row.timestamp < c.timestamp - AUTHOR_LOOKBACK_MS) continue;
            if (row.change_type === "commit" || row.change_type === "delete" || !known.has(id) || hit.has(id)) continue;
            hit.add(id);
            const s = score.get(id) ?? { id: row.conversation_id, files: 0 };
            s.files += 1;
            score.set(id, s);
          }
        }
      }
      const top = [...score.values()].sort((a, b) => b.files - a.files || String(a.id).localeCompare(String(b.id))).slice(0, AUTHORS_PER_COMMIT);
      if (top.length) out[c.sha] = top.map((t) => t.id);
    }
    return out;
  },
});

/** The sessions among `conversation_ids` the team may draw on, through teamVisibleInputs(). */
export const readVisible = internalQuery({
  args: { team_id: v.id("teams"), conversation_ids: v.array(v.id("conversations")) },
  handler: async (ctx, args): Promise<GateRow[]> => {
    const inputs = await teamVisibleInputs(ctx, args.team_id, args.conversation_ids);
    return await Promise.all([...inputs.values()].map(async (input) => {
      const links = await ctx.db
        .query("pull_request_sessions")
        .withIndex("by_conversation", (q) => q.eq("conversation_id", input.conversation_id))
        .take(20);
      return {
        conversation_id: input.conversation_id,
        owner_id: input.owner_id,
        mode: input.mode,
        membership_level: input.membership_level,
        task_ids: input.active_task_id ? [String(input.active_task_id)] : [],
        outcome_type: input.insight?.outcome_type ?? null,
        insight: input.insight ? { id: String(input.insight._id), generated_at: input.insight.generated_at } : null,
        pr_ids: links.map((l) => l.pull_request_id),
      };
    }));
  },
});

export type PrRow = ChangePr & { updated_at: number };

/** The team's pull requests in this repository among `pr_ids`, as layer 0 joins them. */
export const readPrs = internalQuery({
  args: { team_id: v.id("teams"), repository: v.string(), pr_ids: v.array(v.id("pull_requests")) },
  handler: async (ctx, args): Promise<PrRow[]> => {
    const repository = normalizeRepository(args.repository);
    const rows = await Promise.all(args.pr_ids.map((id) => ctx.db.get(id)));
    return rows
      .filter((pr): pr is Doc<"pull_requests"> => !!pr && String(pr.team_id) === String(args.team_id) && normalizeRepository(pr.repository) === repository)
      .map((pr) => ({
        id: String(pr._id),
        number: pr.number,
        updated_at: pr.updated_at,
        conversation_ids: pr.linked_session_ids.map(String),
        shas: [...new Set([...(pr.commits ?? []).map((c) => c.sha), ...(pr.head_sha ? [pr.head_sha] : [])])],
      }));
  },
});

/** The ship an external event records: a pushed tag (`release`) or `cast ship mark` (`deploy`). */
export function shipOf(e: Pick<Doc<"external_events">, "kind" | "sha" | "created_at" | "meta">): ShipEvent | null {
  if (e.kind !== "release" && e.kind !== "deploy") return null;
  const surface = e.meta?.surface ?? (e.kind === "release" ? "release" : null);
  if (!surface || !e.sha) return null;
  return { surface, ...(e.meta?.version ? { version: e.meta.version } : {}), sha: e.sha, at: e.created_at, kind: e.kind };
}

/** One page of the repository's ship events and merged pull requests in [from, to). */
export const readEventsPage = internalQuery({
  args: {
    team_id: v.id("teams"),
    repository: v.string(),
    from: v.number(),
    to: v.number(),
    order: v.union(v.literal("asc"), v.literal("desc")),
    cursor: cursorArg,
  },
  handler: async (ctx, args): Promise<{ ships: ShipEvent[]; merged: Array<{ pr_id: Id<"pull_requests">; at: number }>; cursor: string; done: boolean }> => {
    const page = await ctx.db
      .query("external_events")
      .withIndex("by_repository_created", (q) =>
        q.eq("repository", normalizeRepository(args.repository)).gte("created_at", args.from).lt("created_at", args.to))
      .order(args.order)
      .paginate({ numItems: EVENT_PAGE, cursor: args.cursor });
    const ours = page.page.filter((e) => String(e.team_id) === String(args.team_id));
    return {
      ships: ours.map(shipOf).filter((s): s is ShipEvent => !!s),
      merged: ours.filter((e) => e.kind === "pr_merged" && e.pr_id).map((e) => ({ pr_id: e.pr_id!, at: e.created_at })),
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

// ── Writes ───────────────────────────────────────────────────────────────

export const releaseArg = v.object({ surface: v.string(), version: v.optional(v.string()), sha: v.string(), at: v.number() });

const storyArg = v.object({
  story_key: v.string(),
  area: v.string(),
  branch: v.string(),
  on_default_branch: v.boolean(),
  commit_shas: v.array(v.string()),
  conversation_ids: v.array(v.id("conversations")),
  pr_ids: v.array(v.id("pull_requests")),
  author_names: v.array(v.string()),
  actor_user_ids: v.array(v.id("users")),
  insertions: v.number(),
  deletions: v.number(),
  files_changed: v.number(),
  area_counts: v.record(v.string(), v.number()),
  release: v.optional(releaseArg),
  risks: v.array(v.object({ code: v.string(), evidence: v.array(v.string()) })),
  first_at: v.number(),
  last_at: v.number(),
  headline: v.string(),
  dek: v.string(),
  kind: v.string(),
  importance: v.number(),
  inputs_hash: v.string(),
  private_session_count: v.number(),
  inputs: v.array(v.object({ conversation_id: v.id("conversations"), owner_id: v.id("users"), mode: v.union(v.literal("summary"), v.literal("full")) })),
});

export type StoryWrite = typeof storyArg.type;

/** A ship as stories and editions store it: the release validator has no kind. */
const releaseOf = (s: ShipEvent): typeof releaseArg.type => ({ surface: s.surface, ...(s.version ? { version: s.version } : {}), sha: s.sha, at: s.at });

/** The fields prose owns. Cleared when a story loses a session or a session narrows, so text drawn from it cannot outlive its access. */
const PROSE_CLEARED = { body: undefined, why_source: undefined, risk_lines: undefined } as const;

/** A story whose prose call failed this many times keeps layer 0's text until its inputs move. */
export const PROSE_ATTEMPTS = 3;

/** A failed story with attempts left: the next rebuild of its day writes it again. */
export const retriesProse = (s: Pick<Doc<"change_stories">, "prose_status" | "prose_attempts">) =>
  s.prose_status === "failed" && (s.prose_attempts ?? 1) < PROSE_ATTEMPTS;

const sameValue = (a: unknown, b: unknown) => canonicalCommandArguments({ x: a }) === canonicalCommandArguments({ x: b });

/** Whether prose (or the prose skip path) has written this row's text. */
const hasProse = (row: Doc<"change_stories">) => row.why_source !== undefined;

const storyInputRows = (ctx: { db: any }, storyId: Id<"change_stories">): Promise<Doc<"change_story_inputs">[]> =>
  ctx.db.query("change_story_inputs").withIndex("by_story", (q: any) => q.eq("story_id", storyId)).collect();

/** Whether a session the story was built from is gone or now allows less (`full` to `summary`). */
function inputsNarrowed(rows: Doc<"change_story_inputs">[], inputs: StoryWrite["inputs"]): boolean {
  const now = new Map(inputs.map((i) => [String(i.conversation_id), i.mode]));
  return rows.some((row) => {
    const mode = now.get(String(row.conversation_id));
    return !mode || (mode === "summary" && (row.mode ?? "full") === "full");
  });
}

/** Bring a story's change_story_inputs rows in line with the sessions it was built from. */
async function syncStoryInputs(ctx: { db: any }, storyId: Id<"change_stories">, teamId: Id<"teams">, inputs: StoryWrite["inputs"], rows: Doc<"change_story_inputs">[]) {
  const want = new Map(inputs.map((i) => [String(i.conversation_id), i]));
  const have = new Set<string>();
  for (const row of rows) {
    const key = String(row.conversation_id);
    const w = want.get(key);
    if (!w || have.has(key) || String(w.owner_id) !== String(row.owner_id) || String(row.team_id) !== String(teamId)) {
      await ctx.db.delete(row._id);
      continue;
    }
    if (row.mode !== w.mode) await ctx.db.patch(row._id, { mode: w.mode });
    have.add(key);
  }
  for (const [key, i] of want) {
    if (!have.has(key)) await ctx.db.insert("change_story_inputs", { story_id: storyId, team_id: teamId, conversation_id: i.conversation_id, owner_id: i.owner_id, mode: i.mode });
  }
}

/**
 * Upsert one story by story_key. Facts always follow layer 0. The text is
 * layer 0's until prose writes it; prose then stays while the inputs only
 * grow (a late commit), marked pending so it is rewritten. A story that lost
 * a session, or whose session now allows less, falls back to layer 0's text
 * at once.
 */
async function writeStory(ctx: { db: any }, teamId: Id<"teams">, repository: string, date: string, s: StoryWrite): Promise<{ id: Id<"change_stories">; pending: boolean; changed: boolean }> {
  const { inputs, headline, dek, kind, importance, release, ...rest } = s;
  const facts = { team_id: teamId, repository, date, ...rest, release };
  const text = { headline, dek, kind, importance };
  const existing: Doc<"change_stories"> | null = await ctx.db
    .query("change_stories")
    .withIndex("by_story_key", (q: any) => q.eq("story_key", s.story_key))
    .first();
  if (!existing) {
    const id = await ctx.db.insert("change_stories", { ...facts, ...text, prose_status: "pending" });
    await syncStoryInputs(ctx, id, teamId, inputs, []);
    return { id, pending: true, changed: true };
  }
  const rows = await storyInputRows(ctx, existing._id);
  const kept = new Set(s.conversation_ids.map(String));
  const narrowed = existing.conversation_ids.some((id) => !kept.has(String(id))) || inputsNarrowed(rows, inputs);
  const inputsMoved = existing.inputs_hash !== s.inputs_hash;
  const patch: Record<string, unknown> = { ...facts };
  if (narrowed) Object.assign(patch, text, PROSE_CLEARED, { prose_status: "pending", prose_attempts: undefined });
  else {
    if (!hasProse(existing)) Object.assign(patch, text);
    if (inputsMoved) Object.assign(patch, { prose_status: "pending", prose_attempts: undefined });
    else if (retriesProse(existing)) patch.prose_status = "pending";
  }
  const diff = Object.fromEntries(Object.entries(patch).filter(([k, val]) => !sameValue((existing as any)[k], val)));
  if (Object.keys(diff).length) await ctx.db.patch(existing._id, diff);
  await syncStoryInputs(ctx, existing._id, teamId, inputs, rows);
  return { id: existing._id, pending: (patch.prose_status ?? existing.prose_status) === "pending", changed: Object.keys(diff).length > 0 };
}

/** Upsert a batch of one day's stories. Returns the ids now waiting on prose. */
export const writeStories = internalMutation({
  args: { team_id: v.id("teams"), repository: v.string(), date: v.string(), stories: v.array(storyArg) },
  handler: async (ctx, args): Promise<{ pending: Id<"change_stories">[]; changed: number }> => {
    const pending: Id<"change_stories">[] = [];
    let changed = 0;
    for (const s of args.stories) {
      const r = await writeStory(ctx, args.team_id, args.repository, args.date, s);
      if (r.pending) pending.push(r.id);
      if (r.changed) changed += 1;
    }
    return { pending, changed };
  },
});

/** Delete the day's stories whose key layer 0 no longer produces, with their input rows. */
export const pruneDay = internalMutation({
  args: { team_id: v.id("teams"), repository: v.string(), date: v.string(), keep: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ deleted: number }> => {
    const keep = new Set(args.keep);
    const rows = await ctx.db
      .query("change_stories")
      .withIndex("by_team_repo_date", (q) => q.eq("team_id", args.team_id).eq("repository", args.repository).eq("date", args.date))
      .collect();
    let deleted = 0;
    for (const row of rows) {
      if (keep.has(row.story_key)) continue;
      for (const i of await storyInputRows(ctx, row._id)) await ctx.db.delete(i._id);
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    return { deleted };
  },
});

const statsArg = v.object({
  commits: v.number(),
  stories: v.number(),
  releases: v.number(),
  people: v.number(),
  sessions: v.number(),
  private_sessions: v.number(),
});

export type EditionStats = typeof statsArg.type;

/** Whether the edition carries prose. Without it (facts, failed) the headline is the stats line. */
export const hasEditionProse = (d: Pick<Doc<"digests">, "status">) => d.status === "written" || d.status === "final";

/**
 * The edition's facts: counts and the day's ships. A day with no edition yet
 * gets a `facts` row whose headline is the stats line (spec 4.3); a written
 * edition keeps its prose and takes the new counts.
 */
export const writeEditionFacts = internalMutation({
  args: { team_id: v.id("teams"), repository: v.string(), date: v.string(), stats: statsArg, releases: v.array(releaseArg) },
  handler: async (ctx, args): Promise<{ id: Id<"digests"> | null }> => {
    const existing = await ctx.db
      .query("digests")
      .withIndex("by_team_repo_scope_date", (q) =>
        q.eq("team_id", args.team_id).eq("repository", args.repository).eq("scope", "day").eq("date", args.date))
      .first();
    const facts = { stats: args.stats, releases: args.releases, session_count: args.stats.sessions };
    if (!existing) {
      if (!args.stats.commits && !args.releases.length) return { id: null };
      const id = await ctx.db.insert("digests", {
        team_id: args.team_id,
        repository: args.repository,
        scope: "day",
        date: args.date,
        narrative: "",
        headline: statsHeadline(args.stats),
        generated_at: Date.now(),
        status: "facts",
        ...facts,
      });
      return { id };
    }
    const patch: Record<string, unknown> = { ...facts };
    if (!hasEditionProse(existing)) patch.headline = statsHeadline(args.stats);
    const diff = Object.fromEntries(Object.entries(patch).filter(([k, val]) => !sameValue((existing as any)[k], val)));
    if (Object.keys(diff).length) await ctx.db.patch(existing._id, diff);
    return { id: existing._id };
  },
});

// ── Build ────────────────────────────────────────────────────────────────

export type BuildDayResult = {
  date: string;
  repository: string;
  commits: number;
  stories: number;
  /** Stories whose prose is pending: new, or their inputs moved. The prose pass reads these. */
  pending: Id<"change_stories">[];
  changed: number;
  deleted: number;
  stats: EditionStats;
  releases: ShipEvent[];
};

const chunks = <T,>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

async function readAllCommits(ctx: ActionCtx, args: { team_id: Id<"teams">; repository: string; start: number; end: number }): Promise<ChangeCommit[]> {
  const out: ChangeCommit[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: { commits: ChangeCommit[]; cursor: string; done: boolean } = await ctx.runQuery(internal.changes.readCommitsPage, { ...args, cursor });
    out.push(...page.commits);
    if (page.done) return out;
    cursor = page.cursor;
  }
}

/**
 * Ships from the day's start through a few days after it (what carried the
 * day's stories), merged pull requests within the day, and enough history
 * before the day to find the latest backend deploy for the skew risk.
 */
async function readShips(ctx: ActionCtx, args: { team_id: Id<"teams">; repository: string; start: number; end: number }): Promise<{ ships: ShipEvent[]; merged: Id<"pull_requests">[] }> {
  const ships: ShipEvent[] = [];
  const merged = new Set<Id<"pull_requests">>();
  let cursor: string | null = null;
  for (;;) {
    const page: { ships: ShipEvent[]; merged: Array<{ pr_id: Id<"pull_requests">; at: number }>; cursor: string; done: boolean } =
      await ctx.runQuery(internal.changes.readEventsPage, { team_id: args.team_id, repository: args.repository, from: args.start, to: args.end + SHIP_LOOKAHEAD_MS, order: "asc", cursor });
    ships.push(...page.ships);
    for (const m of page.merged) if (m.at < args.end) merged.add(m.pr_id);
    if (page.done) break;
    cursor = page.cursor;
  }
  cursor = null;
  for (let i = 0; i < DEPLOY_LOOKBACK_PAGES; i++) {
    const page: { ships: ShipEvent[]; cursor: string; done: boolean } =
      await ctx.runQuery(internal.changes.readEventsPage, { team_id: args.team_id, repository: args.repository, from: args.start - DEPLOY_LOOKBACK_MS, to: args.start, order: "desc", cursor });
    ships.push(...page.ships);
    if (page.done || page.ships.some((s) => s.surface === "backend" && s.kind === "deploy")) break;
    cursor = page.cursor;
  }
  return { ships, merged: [...merged] };
}

/** The edition's counts, over the default branch: branch work lives in In the works. */
export function editionStats(
  commits: readonly ChangeCommit[],
  twins: Record<string, string[]>,
  stories: readonly LayerZeroStory[],
  defaultBranch: string,
  visible: ReadonlySet<string>,
  releases: number,
): EditionStats {
  const collapsed = new Set(Object.values(twins).flat());
  const onMain = commits.filter((c) => !collapsed.has(c.sha) && onDefaultBranch(c, defaultBranch));
  const convs = new Set(onMain.map((c) => c.conversation_id).filter((id): id is string => !!id));
  const sessions = [...convs].filter((id) => visible.has(id)).length;
  return {
    commits: onMain.length,
    stories: stories.filter((s) => s.on_default_branch).length,
    releases,
    // By personKey, the identity the page's person chips and avatars use: one person under two emails is one person.
    people: new Set(onMain.map((c) => personKey(c.author_name, c.author_email))).size,
    sessions,
    private_sessions: convs.size - sessions,
  };
}

/**
 * Build and store one team-local day of a repository: read, gate, cluster,
 * write, prune, and refresh the edition's facts. Idempotent: a rerun over the
 * same rows writes nothing.
 */
export async function runBuildDay(ctx: ActionCtx, args: { team_id: Id<"teams">; repository: string; date: string }): Promise<BuildDayResult> {
  const repository = normalizeRepository(args.repository);
  const team_id = args.team_id;
  const day: { start: number; end: number; default_branch: string | null } = await ctx.runQuery(internal.changes.readDay, { team_id, repository, date: args.date });
  const window = { team_id, repository, start: day.start, end: day.end };

  const commits = await readAllCommits(ctx, window);
  const { ships, merged } = await readShips(ctx, window);

  // Who wrote each main-branch commit, beside the session its trailer names.
  const authors: Record<string, Id<"conversations">[]> = {};
  const authored = commits.filter((c) => !c.branch || c.branch === day.default_branch || c.branch === "main" || c.branch === "master");
  for (const batch of chunks(authored, AUTHOR_CHUNK)) {
    Object.assign(authors, await ctx.runQuery(internal.changes.readAuthors, {
      team_id, repository, since: day.start - AUTHOR_LOOKBACK_MS, until: day.end + AUTHOR_LOOKAHEAD_MS,
      commits: batch.map((c) => ({ sha: c.sha, timestamp: c.timestamp, paths: c.top_paths ?? [] })),
    }));
  }
  const convIds = [...new Set([
    ...commits.map((c) => c.conversation_id).filter((id): id is string => !!id),
    ...Object.values(authors).flat().map(String),
  ])] as Id<"conversations">[];
  const gate: GateRow[] = [];
  for (const ids of chunks(convIds, GATE_CHUNK)) {
    gate.push(...(await ctx.runQuery(internal.changes.readVisible, { team_id, conversation_ids: ids })));
  }
  const gateById = new Map(gate.map((g) => [String(g.conversation_id), g]));

  // A commit's own pull request is joined only when its session passed (or it has none): layer 0 withholds the rest.
  const prIds = new Set<Id<"pull_requests">>(merged);
  for (const c of commits) if (c.pr_id && (!c.conversation_id || gateById.has(c.conversation_id))) prIds.add(c.pr_id as Id<"pull_requests">);
  for (const g of gate) for (const id of g.pr_ids) prIds.add(id);
  const prs: PrRow[] = [];
  for (const ids of chunks([...prIds], PR_CHUNK)) {
    prs.push(...(await ctx.runQuery(internal.changes.readPrs, { team_id, repository, pr_ids: ids })));
  }
  const prById = new Map(prs.map((p) => [p.id, p]));

  const result = buildLayerZero({
    team_id: String(team_id),
    repository,
    date: args.date,
    default_branch: day.default_branch,
    commits,
    visible: gate.map((g) => ({
      conversation_id: String(g.conversation_id),
      task_ids: g.task_ids,
      ...(g.outcome_type ? { outcome_type: g.outcome_type } : {}),
    })),
    prs,
    ships,
  });

  const writes: StoryWrite[] = result.stories.map((s) => {
    // The story's own sessions, then its commits' authors: grouping stays on
    // the trailers, and the authors only add what the story can tell.
    const named = [...new Set([...s.conversation_ids, ...s.commit_shas.flatMap((sha) => (authors[sha] ?? []).map(String))])];
    const rows = named.filter((id) => gateById.has(id)).slice(0, STORY_SESSIONS).map((id) => gateById.get(id)!);
    const storyPrs = s.pr_ids.map((id) => prById.get(id)).filter((p): p is PrRow => !!p);
    return {
      story_key: s.story_key,
      area: s.area,
      branch: s.branch,
      on_default_branch: s.on_default_branch,
      commit_shas: s.commit_shas,
      conversation_ids: rows.map((g) => g.conversation_id),
      pr_ids: storyPrs.map((p) => p.id as Id<"pull_requests">),
      author_names: s.author_names,
      actor_user_ids: [...new Map(rows.map((g) => [String(g.owner_id), g.owner_id])).values()],
      insertions: s.insertions,
      deletions: s.deletions,
      files_changed: s.files_changed,
      area_counts: s.area_counts,
      ...(s.release ? { release: releaseOf(s.release) } : {}),
      risks: s.risks,
      first_at: s.first_at,
      last_at: s.last_at,
      headline: s.headline,
      dek: s.dek,
      kind: s.kind,
      importance: s.importance,
      inputs_hash: inputsHash({
        prompt_version: STORY_PROMPT_VERSION,
        shas: s.commit_shas,
        insights: rows.flatMap((g) => (g.insight ? [g.insight] : [])),
        visibility: rows.map((g) => ({ conversation_id: String(g.conversation_id), mode: g.mode })),
        membership: rows.map((g) => ({ conversation_id: String(g.conversation_id), level: g.membership_level })),
        prs: storyPrs.map((p) => ({ id: p.id, updated_at: p.updated_at })),
        risks: s.risks.map((r) => r.code),
      }),
      private_session_count: s.private_conversation_count,
      inputs: rows.map((g) => ({ conversation_id: g.conversation_id, owner_id: g.owner_id, mode: g.mode })),
    };
  });

  const pending: Id<"change_stories">[] = [];
  let changed = 0;
  for (const batch of chunks(writes, WRITE_CHUNK)) {
    const r: { pending: Id<"change_stories">[]; changed: number } = await ctx.runMutation(internal.changes.writeStories, { team_id, repository, date: args.date, stories: batch });
    pending.push(...r.pending);
    changed += r.changed;
  }
  const { deleted }: { deleted: number } = await ctx.runMutation(internal.changes.pruneDay, { team_id, repository, date: args.date, keep: writes.map((w) => w.story_key) });

  const releases = result.ships.filter((s) => s.at >= day.start && s.at < day.end);
  const stats = editionStats(commits, result.twins, result.stories, result.default_branch, new Set(gateById.keys()), releases.length);
  await ctx.runMutation(internal.changes.writeEditionFacts, {
    team_id,
    repository,
    date: args.date,
    stats,
    releases: releases.map(releaseOf),
  });

  return { date: args.date, repository, commits: commits.length, stories: writes.length, pending, changed, deleted, stats, releases };
}

export const buildDay = internalAction({
  args: { team_id: v.id("teams"), repository: v.string(), date: v.string() },
  handler: async (ctx, args): Promise<BuildDayResult> => runBuildDay(ctx, args),
});
