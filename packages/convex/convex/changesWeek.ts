// The week edition of the Changes page (docs/proposals/changes-page.md 3,
// level 4): a 3 to 5 sentence standfirst, the week's five biggest stories, a
// release ledger and area totals, kept on a `digests` row of scope "week"
// whose date is the ISO week (`2026-W40`).
//
// A week is built only from its seven day editions and their stories' text,
// never from commits or sessions: every word it reads already passed the story
// gate, so it inherits the story privacy boundary. The privacy reset in
// lib/changesDirty.ts drops a week's prose with its day's.
//
// A day edition finalizing (changesProse.runProse) schedules the week's build,
// debounced on the row's scheduled_id, so a backfill of seven days costs one
// build. The build writes the deterministic facts first (stats headline,
// heaviest five, ledger, areas), then asks the strong model once when the
// inputs moved. The reply lands only over the day editions and story text it
// was asked about.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  clip,
  hash64,
  isoWeekOf,
  ledgerLabel,
  releaseLedger,
  statsHeadline,
  topWeekStories,
  weekAreaTotals,
  weekDates,
  weekStats,
  byStoryWeight,
  type AreaTotal,
  type WeekRelease,
  type WeekStats,
} from "@codecast/shared/changes";
import { STRONG_MODEL, callModel, parseJsonBlock, type SurfaceRequest } from "./lib/anthropic";
import { BACKFILL_DAYS, RECONCILE_DAYS, changesZone } from "./lib/changesDirty";
import { addDays, dayBounds, localDate, teamDayBounds } from "./lib/teamDay";
import { hasEditionProse, releaseArg } from "./changes";
import { hasModelKey, sentences, spend, str, usageArg, usageOf, type Usage } from "./changesProse";

export const WEEK_PROMPT_VERSION = "week-2";

/** A week build runs this long after the first day edition that asked for it. */
export const WEEK_DELAY_MS = 10 * 60_000;
/** What one week edition may spend over all its calls (spec 7.8 puts a week at about $0.05). */
export const WEEK_CAP_USD = 0.5;
/** Stories the editor chooses the week's biggest from. */
const WEEK_STORIES = 30;
export const WEEK_HEADLINE_MAX = 110;
export const WEEK_STANDFIRST_SENTENCES = 5;
const WEEK_MAX_TOKENS = 8000;
const WEEK_TIMEOUT_MS = 120_000;
/** Reconciled week builds go out this far apart. */
const WEEK_RECONCILE_SPACING_MS = 30_000;

const weekArgs = { team_id: v.id("teams"), repository: v.string(), week: v.string() };

// ── Reads ────────────────────────────────────────────────────────────────

/** What the week reads of a day edition. */
export type DayEditionFacts = Pick<Doc<"digests">, "date" | "status" | "headline" | "narrative" | "stats" | "releases" | "inputs_hash">;

/** What the week reads of a story: its facts and its gated text. */
export type WeekStory = Pick<
  Doc<"change_stories">,
  "_id" | "story_key" | "date" | "area" | "kind" | "importance" | "headline" | "dek" | "insertions" | "deletions" | "area_counts" | "release" | "author_names"
>;

export type WeekDay = { date: string; end: number; edition: DayEditionFacts | null; stories: WeekStory[] };

const editionFacts = (d: Doc<"digests">): DayEditionFacts => ({
  date: d.date,
  status: d.status,
  headline: d.headline,
  narrative: d.narrative,
  stats: d.stats,
  releases: d.releases,
  inputs_hash: d.inputs_hash,
});

const storyFacts = (s: Doc<"change_stories">): WeekStory => ({
  _id: s._id,
  story_key: s.story_key,
  date: s.date,
  area: s.area,
  kind: s.kind,
  importance: s.importance,
  headline: s.headline,
  dek: s.dek,
  insertions: s.insertions,
  deletions: s.deletions,
  area_counts: s.area_counts,
  release: s.release,
  author_names: s.author_names,
});

const dayEditionQuery = (ctx: { db: any }, teamId: Id<"teams">, repository: string, from: string, to: string) =>
  ctx.db
    .query("digests")
    .withIndex("by_team_repo_scope_date", (q: any) => q.eq("team_id", teamId).eq("repository", repository).eq("scope", "day").gte("date", from).lte("date", to));

/** One day of the week: its edition and its default-branch stories. */
export const readWeekDay = internalQuery({
  args: { team_id: v.id("teams"), repository: v.string(), date: v.string() },
  handler: async (ctx, args): Promise<WeekDay> => {
    const edition: Doc<"digests"> | null = await dayEditionQuery(ctx, args.team_id, args.repository, args.date, args.date).first();
    const stories = await ctx.db
      .query("change_stories")
      .withIndex("by_team_repo_date", (q) => q.eq("team_id", args.team_id).eq("repository", args.repository).eq("date", args.date))
      .collect();
    const day = await teamDayBounds(ctx, args.team_id, args.date);
    return {
      date: args.date,
      end: day.end,
      edition: edition ? editionFacts(edition) : null,
      stories: stories.filter((s) => s.on_default_branch).map(storyFacts),
    };
  },
});

const weekRow = (ctx: { db: any }, teamId: Id<"teams">, repository: string, week: string): Promise<Doc<"digests"> | null> =>
  ctx.db
    .query("digests")
    .withIndex("by_team_repo_scope_date", (q: any) => q.eq("team_id", teamId).eq("repository", repository).eq("scope", "week").eq("date", week))
    .first();

// ── Facts ────────────────────────────────────────────────────────────────

export type WeekFacts = {
  stats: WeekStats;
  releases: WeekRelease[];
  area_totals: AreaTotal[];
  /** The heaviest five, the week's biggest stories until an editor picks. */
  top_story_keys: string[];
};

/** The week's deterministic facts, from its day editions and their stories. */
export function weekFacts(days: readonly WeekDay[]): WeekFacts {
  const stories = days.flatMap((d) => d.stories);
  const ships = new Map<string, WeekRelease>();
  for (const d of days) for (const r of d.edition?.releases ?? []) ships.set(`${r.surface}|${r.sha}`, r);
  const releases = [...ships.values()].sort((a, b) => a.at - b.at || a.surface.localeCompare(b.surface));
  return {
    stats: weekStats(days.map((d) => d.edition?.stats), stories.flatMap((s) => s.author_names), releases.length),
    releases,
    area_totals: weekAreaTotals(stories),
    top_story_keys: topWeekStories(stories).map((s) => s.story_key),
  };
}

// ── Prompt ───────────────────────────────────────────────────────────────

export type WeekPromptStory = {
  /** A short ref (w1, w2) the reply names stories by; mapped back to story keys. */
  key: string;
  day: string;
  area: string;
  kind: string;
  importance: number;
  headline: string;
  dek: string;
  insertions: number;
  deletions: number;
  release?: string;
};

/** Everything the week prompt reads, as plain data. Built only from day editions and story text. */
export type WeekPromptInput = {
  week: string;
  stats: Omit<WeekStats, "private_sessions">;
  /** Each day with an edition: its headline and standfirst when it has prose, and its counts. */
  days: Array<{ day: string; headline: string | null; standfirst: string | null; commits: number; stories: number }>;
  /** "cli 1.1.157 to 1.1.163, 7 releases". */
  ledger: string[];
  areas: AreaTotal[];
  /** The week's heaviest stories, at most 30. */
  stories: WeekPromptStory[];
};

export type WeekLoad = {
  input: WeekPromptInput;
  /** Ref (w1) to story_key. */
  keys: Record<string, string>;
  /** The stories the prompt quotes: the write checks their text has not moved. */
  candidates: Id<"change_stories">[];
  hash: string;
  /** The day editions and story text the prompt was built from (sourcesSignature). */
  sources: string;
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayName = (date: string) => `${WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${date}`;

/**
 * What a week's prose was written over: its day editions and the text of the
 * stories it quotes. A write recomputes it, so prose written over a day whose
 * edition or stories changed (a session that went private resets both) is
 * dropped.
 */
export function sourcesSignature(editions: readonly DayEditionFacts[], stories: ReadonlyArray<Pick<WeekStory, "_id" | "headline" | "dek" | "importance" | "area" | "kind">>): string {
  return hash64([
    "week-sources",
    ...[...editions].sort((a, b) => a.date.localeCompare(b.date)).map((e) => JSON.stringify([e.date, e.status, e.inputs_hash, e.headline, e.narrative, e.stats, e.releases])),
    ...[...stories].sort((a, b) => String(a._id).localeCompare(String(b._id))).map((s) => JSON.stringify([s._id, s.headline, s.dek, s.importance, s.area, s.kind])),
  ]);
}

/** The week prompt's input, or null when nothing landed on the default branch all week. */
export function weekPromptInput(week: string, days: readonly WeekDay[], facts: WeekFacts): WeekLoad | null {
  const ranked = days.flatMap((d) => d.stories).sort(byStoryWeight).slice(0, WEEK_STORIES);
  if (!ranked.length) return null;
  const keys: Record<string, string> = {};
  const stories = ranked.map((s, n): WeekPromptStory => {
    const key = `w${n + 1}`;
    keys[key] = s.story_key;
    return {
      key,
      day: dayName(s.date),
      area: s.area,
      kind: s.kind,
      importance: s.importance,
      headline: s.headline,
      dek: s.dek,
      insertions: s.insertions,
      deletions: s.deletions,
      ...(s.release ? { release: `${s.release.surface} ${s.release.version ?? s.release.sha.slice(0, 7)}` } : {}),
    };
  });
  const editions = days.flatMap((d) => (d.edition ? [d.edition] : []));
  const { private_sessions: _p, ...stats } = facts.stats;
  const input: WeekPromptInput = {
    week,
    stats,
    days: editions.map((e) => {
      const prose = hasEditionProse(e);
      return {
        day: dayName(e.date),
        headline: prose ? e.headline ?? null : null,
        standfirst: prose && e.narrative.trim() ? e.narrative.trim() : null,
        commits: e.stats?.commits ?? 0,
        stories: e.stats?.stories ?? 0,
      };
    }),
    ledger: releaseLedger(facts.releases).map(ledgerLabel),
    areas: facts.area_totals,
    stories,
  };
  return {
    input,
    keys,
    candidates: ranked.map((s) => s._id),
    hash: hash64(["week", WEEK_PROMPT_VERSION, STRONG_MODEL, JSON.stringify(input), JSON.stringify(keys)]),
    sources: sourcesSignature(editions, ranked),
  };
}

const WEEK_SYSTEM = `You are the editor of a team's Changes page. Each day has an edition of what the team shipped; once a week you write the week's edition for a teammate coming back from a few days away, who wants the shape of the week in under a minute. You are given the week's day editions and its biggest stories, already written. Answer with one JSON object and nothing else.`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function renderWeekInput(i: WeekPromptInput): string {
  const s = i.stats;
  const out: string[] = [`Week: ${i.week}.`, `${s.commits} commits, ${s.stories} stories, ${s.releases} releases, ${s.people} people, ${s.sessions} team-visible sessions.`];
  out.push("", "Days:");
  for (const d of i.days) {
    out.push(`- ${d.day} (${plural(d.commits, "commit")}, ${plural(d.stories, "story", "stories")})${d.headline ? `: ${d.headline}` : ""}`);
    if (d.standfirst) out.push(`    ${d.standfirst}`);
  }
  if (i.ledger.length) out.push("", "Releases:", ...i.ledger.map((l) => `- ${l}`));
  if (i.areas.length) out.push("", "Areas:", ...i.areas.map((a) => `- ${a.area}: ${plural(a.stories, "story", "stories")}, ${plural(a.files, "file")} touched`));
  out.push("", "Biggest stories:");
  for (const st of i.stories) {
    const facts = [st.day, st.area, st.kind, `importance ${st.importance}`, `+${st.insertions} -${st.deletions}`];
    if (st.release) facts.push(`shipped in ${st.release}`);
    out.push(`- ${st.key} [${facts.join("; ")}] ${st.headline}`);
    if (st.dek) out.push(`    ${st.dek}`);
  }
  return out.join("\n");
}

/** The week request prod posts: one call on the strong model (spec 7.8). */
export function weekRequest(input: WeekPromptInput): SurfaceRequest {
  const prompt = `${renderWeekInput(input)}

Edit this week into an edition.

- The headline is the week's news in one plain sentence: the change that mattered most and what it means for the team. It is a headline, not an inventory, so it does not string areas, releases or topics together; a release belongs in it only when shipping it was the news. Sentence case, at most ${WEEK_HEADLINE_MAX} characters.
- The standfirst tells the week in three to ${WEEK_STANDFIRST_SENTENCES} sentences: what mattered most, what it adds up to, and what changed for the people who use the product or work on it.
- top_story_keys lists the five stories a teammate most needs to read from this week, most important first, by key.
- Say only what the days and stories say. Give no reason a story does not give, name no one they do not name, and copy ids such as jx7c6zk and #412 exactly.
- No em dashes.

{"week_headline": "...", "standfirst": "...", "top_story_keys": ["w1", "w2", "w3", "w4", "w5"]}`;
  return { model: STRONG_MODEL, max_tokens: WEEK_MAX_TOKENS, system: WEEK_SYSTEM, prompt };
}

export type WeekProse = { headline: string; standfirst: string; top_story_keys: string[] };

/**
 * The week a reply describes, with refs mapped back to story keys. Unknown
 * refs are dropped and the heaviest stories fill the list to five. No
 * headline or no standfirst is unusable.
 */
export function parseWeekReply(text: string, load: Pick<WeekLoad, "keys">, fallbackTop: readonly string[]): WeekProse | null {
  const raw = parseJsonBlock(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const headline = clip(str(r.week_headline), WEEK_HEADLINE_MAX);
  const standfirst = sentences(str(r.standfirst), WEEK_STANDFIRST_SENTENCES);
  if (!headline || !standfirst) return null;
  const picked = Array.isArray(r.top_story_keys) ? r.top_story_keys.map(str).map((k) => load.keys[k]).filter((k): k is string => !!k) : [];
  const top = [...new Set([...picked, ...fallbackTop])].slice(0, fallbackTop.length || picked.length);
  return { headline, standfirst, top_story_keys: top };
}

// ── Scheduling ───────────────────────────────────────────────────────────

/** The row's scheduled build while it has not started. */
async function pendingBuild(ctx: { db: any }, row: Doc<"digests"> | null): Promise<boolean> {
  if (!row?.scheduled_id) return false;
  const job = await ctx.db.system.get(row.scheduled_id);
  return job?.state?.kind === "pending";
}

/** Queue one build of a week unless one is waiting. The row starts as an empty facts row when the week has none yet. */
async function queueWeek(ctx: MutationCtx, teamId: Id<"teams">, repository: string, week: string, row: Doc<"digests"> | null, delay: number): Promise<boolean> {
  if (await pendingBuild(ctx, row)) return false;
  const scheduled_id = await ctx.scheduler.runAfter(delay, internal.changesWeek.rebuildWeek, { team_id: teamId, repository, week });
  if (row) await ctx.db.patch(row._id, { scheduled_id });
  else await ctx.db.insert("digests", { team_id: teamId, repository, scope: "week", date: week, narrative: "", generated_at: Date.now(), status: "facts", scheduled_id });
  return true;
}

/**
 * A day edition finalized: build the week it falls in, once, WEEK_DELAY_MS
 * from the first ask. Later asks ride the pending build.
 */
export const scheduleWeek = internalMutation({
  args: { team_id: v.id("teams"), repository: v.string(), date: v.string() },
  handler: async (ctx, args): Promise<void> => {
    if (!(await changesZone(ctx, args.team_id))) return;
    const week = isoWeekOf(args.date);
    await queueWeek(ctx, args.team_id, args.repository, week, await weekRow(ctx, args.team_id, args.repository, week), WEEK_DELAY_MS);
  },
});

/** The ISO weeks whose Sunday is one of the last `days` days before `today`. */
export function endedWeeks(today: string, days: number): string[] {
  const weeks = new Set<string>();
  for (let i = 1; i <= days; i++) {
    const day = addDays(today, -i);
    if (weekDates(isoWeekOf(day))![6] === day) weeks.add(isoWeekOf(day));
  }
  return [...weeks];
}

/**
 * The 6-hour reconcile's week pass (changesSchedule.reconcile). A week is
 * built when one of its days finalizes, so a week whose build failed after
 * its last day, or whose last commit came before the weekend, would never be
 * built again: every week that ended in the reconcile window and is not final
 * gets one more build. A repository with day editions in a week of the
 * backfill window and no week row at all (its days finalized before weeks
 * were built, or the hook never ran) gets its first build. An unchanged week
 * finalizes without a call, and the week cap bounds the rest.
 */
export const reconcileWeeks = internalMutation({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args): Promise<number> => {
    const zone = await changesZone(ctx, args.team_id);
    if (!zone) return 0;
    const now = Date.now();
    const today = localDate(now, zone);
    const recent = new Set(endedWeeks(today, RECONCILE_DAYS));
    const byDate = (scope: "day" | "week", date: string): Promise<Doc<"digests">[]> =>
      ctx.db.query("digests").withIndex("by_team_scope_date", (q) => q.eq("team_id", args.team_id).eq("scope", scope).eq("date", date)).collect();
    let queued = 0;
    for (const week of endedWeeks(today, BACKFILL_DAYS)) {
      const dates = weekDates(week)!;
      if (dayBounds(dates[6], zone).end > now) continue;
      const rows = new Map<string, Doc<"digests"> | null>();
      for (const date of dates) for (const day of await byDate("day", date)) if (day.repository) rows.set(day.repository, null);
      for (const row of await byDate("week", week)) if (row.repository) rows.set(row.repository, row);
      for (const [repository, row] of rows) {
        if (row && (!recent.has(week) || row.status === "final" || (row.cost_usd ?? 0) >= WEEK_CAP_USD)) continue;
        if (await queueWeek(ctx, args.team_id, repository, week, row, queued * WEEK_RECONCILE_SPACING_MS)) queued += 1;
      }
    }
    return queued;
  },
});

type WeekClaim = Pick<Doc<"digests">, "status" | "inputs_hash" | "cost_usd" | "capped_at"> | null;

/** A build starts: asks from here on schedule the next one. Null with Changes off. */
export const claimWeek = internalMutation({
  args: weekArgs,
  handler: async (ctx, args): Promise<{ row: WeekClaim } | null> => {
    if (!(await changesZone(ctx, args.team_id))) return null;
    const row = await weekRow(ctx, args.team_id, args.repository, args.week);
    if (row?.scheduled_id) await ctx.db.patch(row._id, { scheduled_id: undefined });
    return { row: row ? { status: row.status, inputs_hash: row.inputs_hash, cost_usd: row.cost_usd, capped_at: row.capped_at } : null };
  },
});

// ── Writes ───────────────────────────────────────────────────────────────

const statsArg = v.object({ commits: v.number(), stories: v.number(), releases: v.number(), people: v.number(), sessions: v.number(), private_sessions: v.number() });
const factsArg = v.object({
  stats: statsArg,
  releases: v.array(releaseArg),
  area_totals: v.array(v.object({ area: v.string(), stories: v.number(), files: v.number() })),
  top_story_keys: v.array(v.string()),
});

/** The week's facts. Without prose the headline is the stats line and the heaviest five lead; prose keeps its own. */
export const writeWeekFacts = internalMutation({
  args: { ...weekArgs, facts: factsArg },
  handler: async (ctx, args): Promise<void> => {
    const f = args.facts;
    const row = await weekRow(ctx, args.team_id, args.repository, args.week);
    const facts = { stats: f.stats, releases: f.releases, area_totals: f.area_totals, session_count: f.stats.sessions };
    const deterministic = { headline: statsHeadline(f.stats), top_story_keys: f.top_story_keys };
    if (!row) {
      await ctx.db.insert("digests", {
        team_id: args.team_id, repository: args.repository, scope: "week", date: args.week,
        narrative: "", generated_at: Date.now(), status: "facts", ...facts, ...deterministic,
      });
      return;
    }
    const patch: Record<string, unknown> = { ...facts, ...(hasEditionProse(row) ? {} : deterministic) };
    const diff = Object.fromEntries(Object.entries(patch).filter(([k, val]) => JSON.stringify((row as any)[k]) !== JSON.stringify(val)));
    if (Object.keys(diff).length) await ctx.db.patch(row._id, diff);
  },
});

const weekOutcome = v.union(
  v.object({ status: v.literal("written"), final: v.boolean(), headline: v.string(), standfirst: v.string(), top_story_keys: v.array(v.string()) }),
  // The week ended and nothing moved since its prose: it is final as written.
  v.object({ status: v.literal("final") }),
  v.object({ status: v.literal("failed") }),
);

/**
 * Write the week's prose. It lands only over the day editions and story text
 * it was asked about (the sources signature, recomputed now); otherwise only
 * its cost is kept. A failure leaves earlier prose alone.
 */
export const writeWeekProse = internalMutation({
  args: {
    ...weekArgs,
    inputs_hash: v.string(),
    sources: v.string(),
    candidates: v.array(v.id("change_stories")),
    outcome: weekOutcome,
    usage: v.optional(usageArg),
  },
  handler: async (ctx, args): Promise<"written" | "stale" | "gone"> => {
    const row = await weekRow(ctx, args.team_id, args.repository, args.week);
    if (!row) return "gone";
    const cost = spend(row, args.usage);
    const o = args.outcome;

    if (o.status === "failed") {
      if (hasEditionProse(row)) {
        if (args.usage) await ctx.db.patch(row._id, cost);
      } else {
        await ctx.db.patch(row._id, { status: "failed", generated_at: Date.now(), ...cost });
      }
      return "written";
    }

    const dates = weekDates(args.week);
    const editions: Doc<"digests">[] = dates ? await dayEditionQuery(ctx, args.team_id, args.repository, dates[0], dates[6]).collect() : [];
    const stories: WeekStory[] = [];
    for (const id of args.candidates) {
      const s = await ctx.db.get(id);
      if (s) stories.push(storyFacts(s));
    }
    if (stories.length !== args.candidates.length || sourcesSignature(editions.map(editionFacts), stories) !== args.sources) {
      if (args.usage) await ctx.db.patch(row._id, cost);
      return "stale";
    }
    if (o.status === "final") {
      if (row.inputs_hash === args.inputs_hash && hasEditionProse(row)) await ctx.db.patch(row._id, { status: "final" });
      return "written";
    }
    await ctx.db.patch(row._id, {
      headline: o.headline,
      narrative: o.standfirst,
      top_story_keys: o.top_story_keys,
      inputs_hash: args.inputs_hash,
      status: o.final ? "final" : "written",
      generated_at: Date.now(),
      ...cost,
    });
    return "written";
  },
});

/** The week's cap left its prose unwritten. The first time is kept. */
export const markWeekCapped = internalMutation({
  args: weekArgs,
  handler: async (ctx, args): Promise<void> => {
    const row = await weekRow(ctx, args.team_id, args.repository, args.week);
    if (row && !row.capped_at) await ctx.db.patch(row._id, { capped_at: Date.now() });
  },
});

// ── The build ────────────────────────────────────────────────────────────

export type WeekResult = "written" | "final" | "unchanged" | "capped" | "held" | "failed" | "stale" | "none" | "off";

/**
 * Build one week of a repository: read its seven days, write its facts, then
 * its prose when the inputs moved. A week whose last day has ended is final.
 */
export const rebuildWeek = internalAction({
  args: weekArgs,
  handler: async (ctx, args): Promise<WeekResult> => {
    const dates = weekDates(args.week);
    if (!dates) return "none";
    const claim: { row: WeekClaim } | null = await ctx.runMutation(internal.changesWeek.claimWeek, args);
    if (!claim) return "off";

    const days: WeekDay[] = [];
    for (const date of dates) days.push(await ctx.runQuery(internal.changesWeek.readWeekDay, { team_id: args.team_id, repository: args.repository, date }));
    const facts = weekFacts(days);
    await ctx.runMutation(internal.changesWeek.writeWeekFacts, { ...args, facts });

    const load = weekPromptInput(args.week, days, facts);
    if (!load) return "none";
    const row = claim.row;
    const final = Date.now() >= days[6].end;
    const write = (outcome: typeof weekOutcome.type, usage?: Usage): Promise<"written" | "stale" | "gone"> =>
      ctx.runMutation(internal.changesWeek.writeWeekProse, {
        ...args, inputs_hash: load.hash, sources: load.sources, candidates: load.candidates, outcome, ...(usage ? { usage } : {}),
      });

    if (row && hasEditionProse(row) && row.inputs_hash === load.hash) {
      if (!final || row.status === "final") return "unchanged";
      return (await write({ status: "final" })) === "written" ? "final" : "stale";
    }
    if ((row?.cost_usd ?? 0) >= WEEK_CAP_USD) {
      await ctx.runMutation(internal.changesWeek.markWeekCapped, args);
      return "capped";
    }
    if (!hasModelKey()) return "held";

    const req = weekRequest(load.input);
    const reply = await callModel({ ...req, label: "Changes week", timeout_ms: WEEK_TIMEOUT_MS });
    if (!reply) {
      await write({ status: "failed" });
      return "failed";
    }
    const usage = usageOf(req.model, reply.usage);
    const prose = parseWeekReply(reply.text, load, facts.top_story_keys);
    if (!prose) {
      console.error("Changes week: unusable reply", args.repository, args.week, reply.text.slice(0, 300));
      await write({ status: "failed" }, usage);
      return "failed";
    }
    const r = await write({ status: "written", final, ...prose }, usage);
    return r === "written" ? (final ? "final" : "written") : "stale";
  },
});
