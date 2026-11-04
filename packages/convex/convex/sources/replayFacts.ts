// What PostHog itself says of each recording a source mirrors
// (shared/replay/list.ts ReplayFacts): its true length and active time, its
// clicks, console errors and rage clicks, and where it ran (browser, OS,
// device, country, referrer). Our own copy cannot always say: an import stops
// at a size cap, a tab left open runs hours past its capture, and a recording
// whose chunks expired has no stream to read. The vendor's numbers make every
// row filterable and sortable, imported or not.
//
// Two HogQL queries answer a page of recordings at once: session_replay_events
// for length and activity, events for environment and rage clicks. The tend
// cron (replayBackfill.tend) starts a run per PostHog source every 15 minutes;
// a run walks the source's recordings newest first and stops at the first
// page with nothing to ask, so a quiet source costs one query of our own table
// and no PostHog call. A recording asked while it may still be running is
// asked again until it is RECHECK_MS old. A full walk, ignoring the stop, is
// `sweep`; `force` also asks again rows already asked:
// `packages/convex/run.sh sources/replayFacts:run '{"source_id":"…","force":true}'`.
//
// The run also records where PostHog's own app shows the project
// (event_sources.vendor_web_url), so a replay can link to "Open in PostHog".
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../functions";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ReplayFacts } from "@codecast/shared/replay";
import { replayFactsValidator } from "../ingestSchema";
import { connFor, hogqlBody, hogqlInstant, posthogRequest, type PostHogConn } from "./posthog";
import { patchReplay } from "../lib/replayIndex";

export const FACTS_PAGE = 500;
/** Pages one run walks at most, and the pause between them (PostHog's query endpoint is rate limited per team). */
export const FACTS_MAX_PAGES = 40;
export const FACTS_PAGE_PAUSE_MS = 20_000;
/** A recording asked within this long of its start may still have been running: it is asked again, at most every RECHECK_EVERY_MS. */
export const RECHECK_MS = 3 * 3600_000;
export const RECHECK_EVERY_MS = 20 * 60_000;
const FACTS_READ_MAX_BYTES = 4 * 1024 * 1024;
/** A PostHog session id, the only thing interpolated into the queries. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A recording whose last activity was this close to the ask may still have been running then. */
export const STILL_RUNNING_MS = 30 * 60_000;

/**
 * Whether a row should be asked: never asked, or asked while it may still
 * have been recording: within RECHECK_MS of its start, or (a tab left open
 * for hours) with its known end close to the ask.
 */
export function needsFacts(row: { started_at: number; facts?: { at: number; length_ms?: number } | null }, now: number): boolean {
  if (!row.facts) return true;
  if (now - row.facts.at < RECHECK_EVERY_MS) return false;
  if (row.facts.at - row.started_at < RECHECK_MS) return true;
  return row.facts.length_ms !== undefined && row.facts.at - (row.started_at + row.facts.length_ms) < STILL_RUNNING_MS;
}

/** The two queries for a page of session ids, reading no further back than `since`. */
export function factsQueries(ids: readonly string[], since: number): { lengths: string; env: string } {
  const list = ids.filter((id) => SESSION_ID.test(id)).map((id) => `'${id}'`).join(", ");
  const from = hogqlInstant(since);
  return {
    lengths: `SELECT session_id, dateDiff('second', min(start_time), max(end_time)), sum(active_milliseconds), sum(click_count), sum(console_error_count) FROM session_replay_events WHERE session_id IN (${list}) AND start_time >= ${from} GROUP BY session_id LIMIT ${FACTS_PAGE * 2}`,
    env: `SELECT $session_id, anyIf(properties.$browser, properties.$browser != ''), anyIf(properties.$os, properties.$os != ''), anyIf(properties.$device_type, properties.$device_type != ''), anyIf(properties.$geoip_country_code, properties.$geoip_country_code != ''), argMinIf(properties.$referring_domain, timestamp, event = '$pageview'), countIf(event = '$rageclick') FROM events WHERE $session_id IN (${list}) AND timestamp >= ${from} GROUP BY $session_id LIMIT ${FACTS_PAGE * 2}`,
  };
}

const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : typeof x === "string" && /^\d+(\.\d+)?$/.test(x) ? Number(x) : undefined);
const str = (x: unknown, max = 80): string | undefined => (typeof x === "string" && x.trim() && x !== "$direct" ? x.trim().slice(0, max) : undefined);

/** The facts each id's rows say. Every asked id gets an entry, `at` alone when PostHog knew nothing of it. */
export function parseFacts(ids: readonly string[], lengths: unknown[], env: unknown[], at: number): Map<string, ReplayFacts> {
  const out = new Map<string, ReplayFacts>(ids.map((id) => [id, { at }]));
  const put = (id: unknown, patch: Partial<ReplayFacts>) => {
    if (typeof id !== "string" || !out.has(id)) return;
    const cur = out.get(id)!;
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) (cur as any)[k] = val;
  };
  for (const r of lengths) {
    if (!Array.isArray(r)) continue;
    const secs = num(r[1]);
    put(r[0], { length_ms: secs !== undefined ? secs * 1000 : undefined, active_ms: num(r[2]), clicks: num(r[3]), console_errors: num(r[4]) });
  }
  for (const r of env) {
    if (!Array.isArray(r)) continue;
    put(r[0], { browser: str(r[1]), os: str(r[2]), device: str(r[3]), country: str(r[4], 8)?.toUpperCase(), referrer: str(r[5], 200), rage_clicks: num(r[6]) });
  }
  return out;
}

/** Where PostHog's own app shows a project. */
export function posthogWebUrl(conn: Pick<PostHogConn, "host" | "project_id">): string {
  return `${conn.host.replace(/\/+$/, "")}/project/${encodeURIComponent(conn.project_id)}`;
}

/** One page of a source's recordings, newest first, with the ones to ask. */
export const factsPage = internalQuery({
  args: { source_id: v.id("event_sources"), cursor: v.union(v.string(), v.null()), now: v.number(), force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("replays")
      .withIndex("by_source_started", (q) => q.eq("source_id", args.source_id))
      .order("desc")
      .paginate({ cursor: args.cursor, numItems: FACTS_PAGE });
    const ask = args.force ? page.page : page.page.filter((r) => needsFacts(r, args.now));
    return {
      rows: ask.map((r) => ({ replay_id: r._id, external_id: r.external_id, started_at: r.started_at })),
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

/**
 * Facts onto their rows. The length is a floor under the row's own (never
 * shortens it); the vendor's clicks and errors stand in for counts only until
 * the row's stream is read, which recounts them.
 */
export const saveFacts = internalMutation({
  args: { items: v.array(v.object({ replay_id: v.id("replays"), facts: replayFactsValidator })) },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const { replay_id, facts } of args.items) {
      const row = await ctx.db.get(replay_id);
      if (!row) continue;
      const merged = { ...(row.facts ?? {}), ...facts, ...(row.facts?.length_ms && facts.length_ms ? { length_ms: Math.max(row.facts.length_ms, facts.length_ms) } : {}) };
      const length = Math.max(row.duration_ms ?? 0, merged.length_ms ?? 0);
      await patchReplay(ctx, row, {
        facts: merged,
        ...(length > 0 && length !== row.duration_ms ? { duration_ms: length } : {}),
        ...(!row.timeline_at && (facts.clicks !== undefined || facts.console_errors !== undefined)
          ? { counts: { ...row.counts, clicks: facts.clicks ?? row.counts.clicks, errors: facts.console_errors ?? row.counts.errors } }
          : {}),
        updated_at: now,
      });
    }
  },
});

export const setWebUrl = internalMutation({
  args: { source_id: v.id("event_sources"), url: v.string() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (source && source.vendor_web_url !== args.url) await ctx.db.patch(source._id, { vendor_web_url: args.url });
  },
});

async function hogql(conn: PostHogConn, query: string): Promise<unknown[]> {
  const answer = await posthogRequest(conn, "/query/", { method: "POST", body: hogqlBody(query), maxBytes: FACTS_READ_MAX_BYTES });
  if (!answer.ok) throw new Error(answer.error);
  const body = JSON.parse(answer.text);
  return Array.isArray(body?.results) ? body.results : [];
}

/** Ask PostHog for one page of a source's recordings, then schedule the next while there is something to ask. */
export const run = internalAction({
  args: { source_id: v.id("event_sources"), cursor: v.optional(v.union(v.string(), v.null())), page: v.optional(v.number()), sweep: v.optional(v.boolean()), force: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ asked: number; done: boolean }> => {
    const input = await ctx.runQuery(internal.sources.posthog.sourceForPoll, { source_id: args.source_id });
    if (!input || input.status !== "active") return { asked: 0, done: true };
    const conn = await connFor(ctx, input);
    if ("error" in conn) return { asked: 0, done: true };
    const pageNo = args.page ?? 0;
    if (pageNo === 0) await ctx.runMutation(internal.sources.replayFacts.setWebUrl, { source_id: args.source_id, url: posthogWebUrl(conn) });
    const now = Date.now();
    const page = await ctx.runQuery(internal.sources.replayFacts.factsPage, { source_id: args.source_id, cursor: args.cursor ?? null, now, ...(args.force ? { force: true } : {}) });
    if (page.rows.length) {
      const ids = page.rows.map((r) => r.external_id);
      // A day before the oldest start: the tables are partitioned by time, and a recording's events start with it.
      const since = Math.min(...page.rows.map((r) => r.started_at)) - 86_400_000;
      const q = factsQueries(ids, since);
      try {
        const [lengths, env] = [await hogql(conn, q.lengths), await hogql(conn, q.env)];
        const facts = parseFacts(ids, lengths, env, now);
        const items = page.rows.map((r) => ({ replay_id: r.replay_id as Id<"replays">, facts: facts.get(r.external_id)! }));
        for (let i = 0; i < items.length; i += 100) await ctx.runMutation(internal.sources.replayFacts.saveFacts, { items: items.slice(i, i + 100) });
      } catch (err) {
        // A refusal or a rate limit ends this run; the next tend starts over from the newest.
        console.warn(`replay facts for ${args.source_id} not read: ${err instanceof Error ? err.message : String(err)}`);
        return { asked: 0, done: true };
      }
    }
    const more = !page.done && pageNo + 1 < FACTS_MAX_PAGES && (page.rows.length > 0 || args.sweep || args.force);
    if (more) await ctx.scheduler.runAfter(page.rows.length ? FACTS_PAGE_PAUSE_MS : 0, internal.sources.replayFacts.run, { source_id: args.source_id, cursor: page.cursor, page: pageNo + 1, ...(args.sweep ? { sweep: true } : {}), ...(args.force ? { force: true } : {}) });
    return { asked: page.rows.length, done: !more };
  },
});
