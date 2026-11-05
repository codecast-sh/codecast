// Replay reads (replays.ts): the list row a client sees, the cached
// timeline, the newest-first list, the detail, and the filtered browse with
// its people and facets. Every read holds rows to the reader's workspace key.
import type { Doc, Id } from "../_generated/dataModel";
import { readableRowByRef } from "./rowByRef";
import { sourceByRef } from "./ingestScope";
import { readTallies, scopeTallies, tallyAnswers } from "./replayTallies";
import { compareReplays, currentTimelineText, envLine, whereOf, exactReplayId, rageClicksOf, replayFacets, replayMatches, replayPeople, sortPeople, REPLAY_BROWSE_SCAN, REPLAY_ENV_KEYS, REPLAY_HAS, REPLAY_PEOPLE_SORTS, REPLAY_SORTS, type ReplayMatch, type ReplayPeopleSort } from "@codecast/shared/replay";

type Db = { db: any };

/** The one write of a replay's cached timeline, in its own table so list reads never carry it. */
export async function writeReplayTimeline(ctx: Db, replayId: Id<"replays">, timelineMd: string, now: number): Promise<void> {
  const existing = await ctx.db.query("replay_timelines").withIndex("by_replay", (q: any) => q.eq("replay_id", replayId)).first();
  if (existing) await ctx.db.patch(existing._id, { timeline_md: timelineMd, updated_at: now });
  else await ctx.db.insert("replay_timelines", { replay_id: replayId, timeline_md: timelineMd, updated_at: now });
}

async function readReplayTimeline(ctx: Db, replayId: Id<"replays">): Promise<string | null> {
  const row = await ctx.db.query("replay_timelines").withIndex("by_replay", (q: any) => q.eq("replay_id", replayId)).first();
  return row ? currentTimelineText(row.timeline_md) : null;
}

/** A list row: never the timeline or the chunk keys. */
export function replayView(row: Doc<"replays">, sourceName: string | null) {
  return {
    _id: row._id,
    short_id: row.short_id,
    // The access key, so a client cache enumerates replays through the same
    // workspace boundary as every other row it holds.
    workspace: row.workspace,
    source_id: row.source_id,
    source_name: sourceName,
    provider: row.provider,
    external_id: row.external_id,
    url: row.url ?? null,
    user: row.user ?? null,
    started_at: row.started_at,
    duration_ms: row.duration_ms ?? null,
    counts: row.counts,
    /** Activity, failures, rage clicks and active time (shared/replay/list.ts); null until the stream is read. */
    shape: row.shape ?? null,
    /** What the vendor says of it: length, activity, browser, OS, device, country, referrer (shared/replay/list.ts ReplayFacts). */
    facts: row.facts ?? null,
    group_ids: row.group_ids,
    chunks: row.chunk_keys.length,
    /** DOM chunks: the capture the player plays. 0 means the replay reads as text only. */
    dom_chunks: row.dom_chunk_keys?.length ?? 0,
    dom_bytes: row.dom_bytes ?? null,
    /** How far an imported copy reaches; below duration_ms when the import stopped short of the vendor's recording. Null when unknown. */
    captured_ms: row.captured_ms ?? null,
    /** A long recording's later parts being read (sources/replayRest.ts): how far, and whether it waits or failed. Null when none runs. */
    import_rest: row.import_rest ? { next_blob: row.import_rest.next_blob, blobs: row.import_rest.blobs, retry_at: row.import_rest.retry_at ?? null, error: row.import_rest.error ?? null, updated_at: row.import_rest.updated_at } : null,
    has_timeline: row.timeline_at !== undefined,
    imported_at: row.imported_at ?? null,
    converter_version: row.converter_version ?? null,
    vendor_refresh_after: row.vendor_refresh_after ?? null,
    /** Why the vendor is waited out until then (shared VENDOR_REFRESH_WHYS). */
    vendor_refresh_why: row.vendor_refresh_why ?? null,
    updated_at: row.updated_at,
  };
}

/** The replay if `userId` holds its workspace, else null: a refusal reads like a missing replay. */
export async function readableReplay(ctx: Db, userId: Id<"users">, ref: string): Promise<Doc<"replays"> | null> {
  return await readableRowByRef(ctx, "replays", userId, ref);
}

export const LIST_MAX = 200;
/**
 * How many of a workspace's newest replays a group filter looks through.
 * Rows carry no timeline (replay_timelines) but up to 60 chunk keys and 50
 * group ids, a few KB at worst, so this stays far under a query's read cap.
 * A group's recordings older than this window are not listed.
 */
export const REPLAY_GROUP_SCAN_MAX = 300;

export async function listCore(ctx: Db, userId: Id<"users">, workspaceKey: string, opts: { source?: string; limit?: number; group_id?: Id<"event_groups"> }) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), LIST_MAX);
  // The ref every other verb takes (name, src-N or id), refused the same way when unknown.
  const sourceId: Id<"event_sources"> | null = opts.source ? (await sourceByRef(ctx, userId, workspaceKey, opts.source))._id : null;
  // A source is in one workspace, so its own index is exact; the workspace
  // check below still holds every row to the reader's key.
  const indexed = sourceId
    ? ctx.db.query("replays").withIndex("by_source_started", (q: any) => q.eq("source_id", sourceId))
    : ctx.db.query("replays").withIndex("by_workspace_started", (q: any) => q.eq("workspace", workspaceKey));
  const rows: Doc<"replays">[] = await indexed.order("desc").take(opts.group_id ? REPLAY_GROUP_SCAN_MAX : limit);
  const names = new Map<string, string | null>();
  const out = [];
  for (const row of rows) {
    if (row.workspace !== workspaceKey) continue;
    if (opts.group_id && !row.group_ids.includes(opts.group_id)) continue;
    const key = String(row.source_id);
    if (!names.has(key)) names.set(key, (await ctx.db.get(row.source_id))?.name ?? null);
    out.push(replayView(row, names.get(key) ?? null));
    if (out.length >= limit) break;
  }
  return out;
}

export async function detailCore(ctx: Db, row: Doc<"replays">) {
  const source = await ctx.db.get(row.source_id);
  const groups = [];
  for (const id of row.group_ids) {
    const g = await ctx.db.get(id);
    if (g) groups.push({ _id: g._id, short_id: g.short_id, kind: g.kind, title: g.title, status: g.status });
  }
  return { ...replayView(row, source?.name ?? null), groups, timeline_md: await readReplayTimeline(ctx, row._id), timeline_at: row.timeline_at ?? null };
}

/**
 * How many of a workspace's (or a source's) newest recordings a browse reads.
 * A row is a few KB at worst (chunk keys, group ids, the shape), so this stays
 * well inside a query's read cap; past it the total says "at least".
 */
export const REPLAY_BROWSE_SCAN_MAX = REPLAY_BROWSE_SCAN;
const BROWSE_PAGE_MAX = 500;
/** People a grouped browse answers by default, and the most a page of them may ask for. */
const BROWSE_PEOPLE_MAX = 200;
const BROWSE_PEOPLE_LIMIT_MAX = 2000;

/**
 * The replay list as a person browses it: the recordings that match a filter
 * (shared/replay/list.ts replayMatches), in the sort they asked for, the first
 * `limit` of them, and how many match in all. The filter runs over the
 * newest REPLAY_BROWSE_SCAN_MAX recordings of the scope (a date filter
 * narrows the scan by the index first), so search, toggles and sorts reach
 * past any one page. `people` also folds the matches by person.
 */
export async function browseCore(
  ctx: Db,
  userId: Id<"users">,
  workspaceKey: string,
  opts: ReplayMatch & { source?: string; sort?: string; limit?: number; people?: boolean; people_sort?: string; people_limit?: number; identified?: boolean },
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), BROWSE_PAGE_MAX);
  const sourceId: Id<"event_sources"> | null = opts.source ? (await sourceByRef(ctx, userId, workspaceKey, opts.source))._id : null;
  const since = opts.since;
  const indexed = sourceId
    ? ctx.db.query("replays").withIndex("by_source_started", (q: any) => (since !== undefined ? q.eq("source_id", sourceId).gte("started_at", since) : q.eq("source_id", sourceId)))
    : ctx.db.query("replays").withIndex("by_workspace_started", (q: any) => (since !== undefined ? q.eq("workspace", workspaceKey).gte("started_at", since) : q.eq("workspace", workspaceKey)));
  // A search for one recording's id reads that recording by its index, however old: the scan would miss one past the newest REPLAY_BROWSE_SCAN_MAX.
  const exact = exactReplayId(opts.q);
  const named = exact ? await ctx.db.query("replays").withIndex("by_short_id", (q: any) => q.eq("short_id", exact)).first() : null;
  // One person's recordings, or the partly imported ones, are read by their own index (lib/replayIndex.ts), so the count the person card and the import line print is the list's exact count, however old the rows.
  const range = (q: any) => (since !== undefined ? q.gte("started_at", since) : q);
  const byPerson = !exact && opts.person
    ? sourceId
      ? ctx.db.query("replays").withIndex("by_source_person", (q: any) => range(q.eq("source_id", sourceId).eq("person_key", opts.person)))
      : ctx.db.query("replays").withIndex("by_workspace_person", (q: any) => range(q.eq("workspace", workspaceKey).eq("person_key", opts.person)))
    : null;
  const byCut = !exact && !byPerson && opts.has?.includes("partial")
    ? sourceId
      ? ctx.db.query("replays").withIndex("by_source_cut", (q: any) => range(q.eq("source_id", sourceId).eq("rest_cut", true)))
      : ctx.db.query("replays").withIndex("by_workspace_cut", (q: any) => range(q.eq("workspace", workspaceKey).eq("rest_cut", true)))
    : null;
  const rows: Doc<"replays">[] = exact
    ? named && named.workspace === workspaceKey && (!sourceId || named.source_id === sourceId) ? [named] : []
    : await (byPerson ?? byCut ?? indexed).order("desc").take(REPLAY_BROWSE_SCAN_MAX);
  const match: ReplayMatch = {
    ...(opts.q?.trim() ? { q: opts.q.trim().toLowerCase() } : {}),
    ...(opts.person ? { person: opts.person } : {}),
    ...(opts.has?.length ? { has: opts.has.filter((h) => (REPLAY_HAS as readonly string[]).includes(h)) } : {}),
    ...(opts.min_ms !== undefined ? { min_ms: opts.min_ms } : {}),
    ...(opts.max_ms !== undefined ? { max_ms: opts.max_ms } : {}),
    ...(opts.active_min_ms ? { active_min_ms: opts.active_min_ms } : {}),
    ...(opts.group ? { group: opts.group } : {}),
    ...(since !== undefined ? { since } : {}),
    ...Object.fromEntries(REPLAY_ENV_KEYS.filter((k) => opts[k]).map((k) => [k, opts[k]!.slice(0, 100)])),
  };
  const matched = rows.filter((row) => row.workspace === workspaceKey && replayMatches(row, match));
  // Each environment filter's options, counted over the rows every other filter keeps, so a picker never offers a dead end.
  const facets = Object.fromEntries(
    REPLAY_ENV_KEYS.map((k) => {
      const rest = { ...match, [k]: undefined };
      return [k, replayFacets(rows.filter((row) => row.workspace === workspaceKey && replayMatches(row, rest)))[k]];
    }),
  );
  const sort = (REPLAY_SORTS as readonly string[]).includes(opts.sort ?? "") ? (opts.sort as (typeof REPLAY_SORTS)[number]) : "newest";
  if (sort !== "newest") matched.sort(compareReplays(sort));
  const names = new Map<string, string | null>();
  const out = [];
  for (const row of matched.slice(0, limit)) {
    const key = String(row.source_id);
    if (!names.has(key)) names.set(key, (await ctx.db.get(row.source_id))?.name ?? null);
    out.push(replayView(row, names.get(key) ?? null));
  }
  // With no filter but the default floor, the stored tallies count every recording and every person exactly (lib/replayTallies.ts), past the scan.
  const tallyRows = !exact && tallyAnswers(match) ? await scopeTallies(ctx, workspaceKey, sourceId) : null;
  const tallied = tallyRows ? readTallies(tallyRows, !!match.active_min_ms) : null;
  const folded = tallied ? tallied.people : replayPeople(matched);
  const people = sortPeople(opts.identified ? folded.filter((p) => !p.anonymous) : folded, (REPLAY_PEOPLE_SORTS as readonly string[]).includes(opts.people_sort ?? "") ? (opts.people_sort as ReplayPeopleSort) : "recent");
  const peopleLimit = Math.min(Math.max(opts.people_limit ?? BROWSE_PEOPLE_MAX, 1), BROWSE_PEOPLE_LIMIT_MAX);
  const peoplePage = opts.people ? people.slice(0, peopleLimit) : null;
  // A tallied person's page and environment come from their newest recording, read by the person index.
  if (tallied && peoplePage) {
    for (const p of peoplePage) {
      const newest: Doc<"replays"> | null = await (sourceId
        ? ctx.db.query("replays").withIndex("by_source_person", (q: any) => q.eq("source_id", sourceId).eq("person_key", p.key))
        : ctx.db.query("replays").withIndex("by_workspace_person", (q: any) => q.eq("workspace", workspaceKey).eq("person_key", p.key))
      ).order("desc").first();
      if (newest) Object.assign(p, { url: newest.url ?? newest.shape?.paths?.[0] ?? null, env: envLine(newest.facts), where: whereOf(newest.facts) });
    }
  }
  for (const p of peoplePage ?? []) if (p.anonymous && p.key !== p.label) p.id = p.key;
  // A rage filter can only test recordings whose shape was read: say how many it could not, so an empty answer is not taken for "none".
  const rageUnchecked = match.has?.includes("rage")
    ? rows.filter((row) => row.workspace === workspaceKey && rageClicksOf(row) === undefined && replayMatches(row, { ...match, has: match.has!.filter((h) => h !== "rage") })).length
    : 0;
  // The active-time floor hides short recordings: say how many, so the list can offer them rather than hold them back in silence.
  const belowActive = match.active_min_ms ? rows.filter((row) => row.workspace === workspaceKey && replayMatches(row, { ...match, active_min_ms: undefined })).length - matched.length : 0;
  return {
    workspace: workspaceKey,
    rows: out,
    total: tallied ? tallied.total : matched.length,
    /** When the oldest match started: what "since" means beside the total. Null when nothing matched. */
    oldest_at: tallied ? tallied.oldest_at : matched.length ? matched.reduce((m, r) => Math.min(m, r.started_at), Infinity) : null,
    /** Recordings every other filter keeps that the active-time floor leaves out. */
    below_active: tallied ? tallied.below : Math.max(0, belowActive),
    /** The scan stopped at REPLAY_BROWSE_SCAN_MAX: older recordings were not looked at, so `total` is a floor. Never when the tallies counted. */
    capped: !tallied && rows.length >= REPLAY_BROWSE_SCAN_MAX,
    /** The total and people came from the stored tallies: exact over every recording. */
    exact: !!tallied,
    people_total: people.length,
    people: peoplePage,
    /** People who are known only by an id, among all of them (before `identified`). */
    people_anonymous: folded.filter((p) => p.anonymous).length,
    rage_unchecked: rageUnchecked,
    /** Browser, OS, device and country values with their counts (replayFacets), for the list's pickers. */
    facets,
  };
}

