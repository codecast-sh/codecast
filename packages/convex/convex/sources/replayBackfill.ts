// The bulk import of a vendor source's recordings (docs/architecture/external-data.md X5).
// A PostHog or Sentry recording is otherwise imported the first time someone
// opens it (vendorReplay.ts); this pulls every recording the vendor still
// keeps inside a window, the way a Slack channel's history comes over
// (slack-chat-mirror.md, "Bringing channels over"):
//
//   - one state object on the source row (`replay_backfill`), written once per
//     page, so `cast sources show`, `cast replay import --status` and the web
//     read the same progress;
//   - one page per scheduled action: list a page of recordings, skip the ones
//     already imported, import the rest through the same importVendorRecording
//     path a read takes (each in its own action, two at a time), then schedule
//     the next page;
//   - a 429 waits out the vendor's Retry-After and redoes the page from where
//     it stopped; a refused token stops the import and the source
//     (lib/sourceHealth.markConnectionLost); any start after a stop continues
//     from the cursor.
//
// The run is named by `started_at`: a page scheduled by an earlier run finds
// another value and does nothing, so a restart never leaves two chains.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation } from "../functions";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { invalidScope } from "../lib/auth";
import { scopeArgs } from "../lib/ingestScopeArgs";
import { scopeOf, sourceByRef } from "../lib/ingestScope";
import { markConnectionLost } from "../lib/sourceHealth";
import { replayBackfillValidator } from "../ingestSchema";
import { sourceViewOf } from "../ingest";
import { VendorCallError } from "./vendorReplay";
import { connFor, importFor, posthogRequest, recordingsPath } from "./posthog";
import { connectionIdForSource, tokenFor } from "../tokenConnectors";
import { importSentryReplay, nextCursor, replayListIds, replaysListUrl, resolveProjectIds, sentryCall, sentryTarget } from "./sentry";
import {
  DEFAULT_REPLAY_BACKFILL_WINDOW,
  REPLAY_BACKFILL_LIMITS,
  isReplayBackfillWindow,
  replayBackfillResumes,
  replayBackfillSince,
  replayBackfillStalled,
  type ReplayBackfill,
} from "@codecast/shared/contracts/replay";

/**
 * One page: recordings listed per action, imported two at a time, inside a
 * time budget well short of an action's ten minutes (a recording's own read is
 * capped by its adapter: 24 MB, 30s a call). A page that imported anything is
 * followed by a pause, which with the page size keeps a PostHog import near
 * 150 calls a minute, under its rate limits; a 429 waits as long as asked.
 */
export const REPLAY_BACKFILL_PAGE = {
  list_size: 10,
  concurrency: 2,
  budget_ms: 4 * 60_000,
  pause_ms: 15_000,
  /** A 429 with no Retry-After, and the most any Retry-After is waited. */
  rate_wait_ms: 60_000,
  max_rate_wait_ms: 15 * 60_000,
  /** A list call that failed for another reason is tried again after this. */
  retry_ms: 60_000,
} as const;

export type VendorFailure = { error: string; status?: number; retry_after_ms?: number; lost?: boolean };
export type ListPage = { ids: string[]; next: string | null };

/** What a page needs of a vendor; the Convex wiring below supplies it, a test supplies fakes. */
export interface BackfillVendor {
  name: string;
  /** Throws a VendorCallError when the vendor refuses. */
  list(cursor: string | undefined): Promise<ListPage>;
  /** The ids that are already imported recordings of this source. */
  imported(ids: string[]): Promise<Set<string>>;
  importOne(id: string): Promise<{ ok: true } | ({ ok: false } & VendorFailure)>;
}

export type PageOutcome = {
  state: ReplayBackfill;
  /** When the next page runs, or null when the import stopped (done, paused, error). */
  next_in_ms: number | null;
  /** The connection no longer works: the source stops on this error too. */
  lost?: string;
};

export function failureOf(e: unknown): VendorFailure {
  if (e instanceof VendorCallError) return { error: e.message, ...(e.status ? { status: e.status } : {}), ...(e.retry_after_ms !== undefined ? { retry_after_ms: e.retry_after_ms } : {}), ...(e.lost ? { lost: true } : {}) };
  return { error: e instanceof Error ? e.message : String(e) };
}

const rateWait = (f: VendorFailure) => Math.min(Math.max(f.retry_after_ms ?? REPLAY_BACKFILL_PAGE.rate_wait_ms, 1_000), REPLAY_BACKFILL_PAGE.max_rate_wait_ms);

/**
 * One page of the import, pure but for the vendor calls: list at the cursor,
 * import what is not ours yet, and answer the state to store and when to run
 * again. The page advances only once every recording on it is imported,
 * failed or already here; until then its handled ids ride `page_seen`, so a
 * page redone after a rate limit or the time budget counts each once.
 */
export async function runBackfillPage(
  vendor: BackfillVendor,
  prev: ReplayBackfill,
  clock: { now: () => number } = { now: Date.now },
): Promise<PageOutcome> {
  const startedAt = clock.now();
  const state: ReplayBackfill = { ...prev };
  const stamp = () => (state.updated_at = clock.now());
  const stop = (status: "paused" | "error", error: string): PageOutcome => {
    state.status = status;
    state.last_error = error.slice(0, 500);
    stamp();
    return { state, next_in_ms: null };
  };
  const failedAgain = (error: string, retry: number): PageOutcome => {
    state.failures_in_row = (state.failures_in_row ?? 0) + 1;
    state.last_error = error.slice(0, 500);
    if (state.failures_in_row >= REPLAY_BACKFILL_LIMITS.failures_in_row) return stop("error", error);
    stamp();
    return { state, next_in_ms: retry };
  };

  let page: ListPage;
  try {
    page = await vendor.list(state.cursor);
  } catch (e) {
    const f = failureOf(e);
    if (f.lost) return { ...stop("paused", f.error), lost: f.error };
    if (f.status === 429) {
      state.last_error = `${vendor.name} is rate limiting the import; waiting`;
      stamp();
      return { state, next_in_ms: rateWait(f) };
    }
    return failedAgain(f.error, REPLAY_BACKFILL_PAGE.retry_ms);
  }

  const seenBefore = new Set(state.page_seen ?? []);
  const seen = new Set(seenBefore);
  const already = await vendor.imported(page.ids);
  const todo = page.ids.filter((id) => !already.has(id) && !seen.has(id));
  let halt: { lost?: string; wait?: number; error?: string } | null = null;
  let importedNow = 0;
  let next = 0;
  const worker = async () => {
    while (!halt && next < todo.length && clock.now() - startedAt < REPLAY_BACKFILL_PAGE.budget_ms) {
      const id = todo[next++];
      const r = await vendor.importOne(id);
      if (r.ok) {
        seen.add(id);
        state.imported++;
        importedNow++;
        state.failures_in_row = 0;
      } else if (r.lost) {
        halt ??= { lost: r.error };
      } else if (r.status === 429) {
        halt ??= { wait: rateWait(r) };
      } else {
        // One recording the vendor will not hand over (gone, corrupt): counted, never retried.
        seen.add(id);
        state.failed++;
        state.failures_in_row = (state.failures_in_row ?? 0) + 1;
        state.last_error = `${id}: ${r.error}`.slice(0, 500);
        if (state.failures_in_row >= REPLAY_BACKFILL_LIMITS.failures_in_row) halt ??= { error: r.error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REPLAY_BACKFILL_PAGE.concurrency, Math.max(todo.length, 1)) }, worker));

  const hold = () => (state.page_seen = [...seen]);
  if (halt?.lost) {
    hold();
    return { ...stop("paused", halt.lost), lost: halt.lost };
  }
  if (halt?.error) {
    hold();
    return stop("error", halt.error);
  }
  if (halt?.wait !== undefined) {
    hold();
    state.last_error = `${vendor.name} is rate limiting the import; waiting`;
    stamp();
    return { state, next_in_ms: halt.wait };
  }
  if (todo.some((id) => !seen.has(id))) {
    // Out of time with recordings left: the same page again, at once.
    hold();
    stamp();
    return { state, next_in_ms: 0 };
  }

  state.listed += page.ids.length;
  state.skipped += page.ids.filter((id) => already.has(id) && !seenBefore.has(id)).length;
  delete state.page_seen;
  if (!state.failures_in_row) delete state.last_error;
  if (page.next === null) {
    state.status = "done";
    delete state.cursor;
    stamp();
    state.finished_at = state.updated_at;
    return { state, next_in_ms: null };
  }
  state.cursor = page.next;
  stamp();
  return { state, next_in_ms: importedNow ? REPLAY_BACKFILL_PAGE.pause_ms : 0 };
}

// ── The vendors ──

/** PostHog's list at an offset, pinned to the import's window so later recordings do not shift it. */
export async function listPostHogPage(conn: Parameters<typeof posthogRequest>[0], state: Pick<ReplayBackfill, "since" | "until">, cursor: string | undefined, fetchImpl?: typeof fetch): Promise<ListPage> {
  const offset = Number(cursor ?? 0) || 0;
  const path = recordingsPath({
    limit: REPLAY_BACKFILL_PAGE.list_size,
    offset,
    // "all" asks for as far back as PostHog's longest retention.
    date_from: state.since !== undefined ? new Date(state.since).toISOString() : "-5y",
    date_to: new Date(state.until).toISOString(),
  });
  const answer = await posthogRequest(conn, path, { maxBytes: 2 * 1024 * 1024 }, fetchImpl);
  if (!answer.ok) throw new VendorCallError(answer);
  let body: any;
  try {
    body = JSON.parse(answer.text);
  } catch {
    throw new VendorCallError({ error: "PostHog's answer is not JSON" });
  }
  const results: any[] = Array.isArray(body?.results) ? body.results : [];
  const ids = results.map((r) => (typeof r?.id === "string" ? r.id : "")).filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id));
  const more = typeof body?.has_next === "boolean" ? body.has_next : results.length >= REPLAY_BACKFILL_PAGE.list_size;
  return { ids, next: more && results.length ? String(offset + results.length) : null };
}

type SourceInputs = { source: Doc<"event_sources">; connection_id: string | null; connection_config?: any };

function vendorFor(ctx: any, input: SourceInputs, state: ReplayBackfill): BackfillVendor {
  const { source } = input;
  const imported = async (ids: string[]) => {
    const known = await ctx.runQuery(internal.replays.importedReplays, { source_id: source._id, external_ids: ids });
    return new Set(ids.filter((id) => known[id]?.imported));
  };
  const importOne = (id: string) => ctx.runAction(internal.sources.replayBackfill.importOne, { source_id: source._id, provider: source.provider, external_id: id });
  if (source.provider === "posthog") {
    return {
      name: "PostHog",
      imported,
      importOne,
      list: async (cursor) => {
        const conn = await connFor(ctx, { config: source.config ?? null, connection_id: input.connection_id });
        if ("error" in conn) throw new VendorCallError({ error: conn.error, lost: true });
        return listPostHogPage(conn, state, cursor);
      },
    };
  }
  return {
    name: "Sentry",
    imported,
    importOne,
    list: async (cursor) => {
      const target = sentryTarget(input.connection_config, source.config);
      if (!target.ok) throw new VendorCallError({ error: target.error, lost: true });
      const cred = await tokenFor(ctx, input.connection_id, "sentry");
      if (!cred.ok) throw new VendorCallError({ error: cred.error, lost: true });
      const projects = await resolveProjectIds(fetch, cred.token, target.target);
      if (!projects.ok) throw new VendorCallError(projects);
      const answer = await sentryCall(fetch, cred.token, replaysListUrl(target.target, projects.ids, state, REPLAY_BACKFILL_PAGE.list_size, cursor));
      if (!answer.ok) throw new VendorCallError(answer);
      return { ids: replayListIds(answer.json), next: nextCursor(answer.link) };
    },
  };
}

// ── Convex functions ──

const VENDORS = ["posthog", "sentry"] as const;

/** The source a page runs for, with the connection it reads through. Never a secret. */
export const pageInputs = internalQuery({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args): Promise<SourceInputs | null> => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return null;
    const connectionId = await connectionIdForSource(ctx, source);
    const connection: any = connectionId ? await ctx.db.get(connectionId as any) : null;
    return { source, connection_id: connectionId ? String(connectionId) : null, connection_config: connection?.config ?? undefined };
  },
});

/** One recording imported through the read path (vendorReplay.importVendorRecording), its failure answered rather than thrown. */
export const importOne = internalAction({
  args: { source_id: v.id("event_sources"), provider: v.string(), external_id: v.string() },
  handler: async (ctx, args): Promise<{ ok: true } | ({ ok: false } & VendorFailure)> => {
    try {
      if (args.provider === "posthog") {
        const input = await ctx.runQuery(internal.sources.posthog.sourceForPoll, { source_id: args.source_id });
        if (!input) return { ok: false, error: "The source was removed", lost: true };
        await importFor(ctx, input, args.external_id);
      } else {
        await importSentryReplay(ctx, args.source_id, args.external_id);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, ...failureOf(e) };
    }
  },
});

/** One page of a running import. Does nothing for a run that is no longer the source's. */
export const runPage = internalAction({
  args: { source_id: v.id("event_sources"), run: v.number() },
  handler: async (ctx, args) => {
    const input: SourceInputs | null = await ctx.runQuery(internal.sources.replayBackfill.pageInputs, { source_id: args.source_id });
    const state = input?.source.replay_backfill;
    if (!input || !state || state.status !== "running" || state.started_at !== args.run) return;
    let outcome: PageOutcome;
    if (input.source.status !== "active") {
      const why = input.source.status === "paused" ? "The source is paused" : `The source stopped: ${input.source.last_error ?? "error"}`;
      outcome = { state: { ...state, status: "paused", last_error: why, updated_at: Date.now() }, next_in_ms: null };
    } else {
      try {
        outcome = await runBackfillPage(vendorFor(ctx, input, state), state);
      } catch (e) {
        // A failure of our own (a query, a scheduler): the page is tried again, and enough of them stop the import.
        const error = e instanceof Error ? e.message : String(e);
        const failures = (state.failures_in_row ?? 0) + 1;
        const stopped = failures >= REPLAY_BACKFILL_LIMITS.failures_in_row;
        outcome = { state: { ...state, failures_in_row: failures, last_error: error.slice(0, 500), updated_at: Date.now(), ...(stopped ? { status: "error" as const } : {}) }, next_in_ms: stopped ? null : REPLAY_BACKFILL_PAGE.retry_ms };
      }
    }
    await ctx.runMutation(internal.sources.replayBackfill.savePage, { source_id: args.source_id, run: args.run, state: outcome.state, next_in_ms: outcome.next_in_ms ?? undefined, lost: outcome.lost });
  },
});

/**
 * A page's progress on the source, and the next page scheduled in the same
 * transaction. A person's stop that landed while the page ran wins: the
 * counts are kept and nothing more is scheduled.
 */
export const savePage = internalMutation({
  args: { source_id: v.id("event_sources"), run: v.number(), state: replayBackfillValidator, next_in_ms: v.optional(v.number()), lost: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    const current = source?.replay_backfill;
    if (!source || !current || current.started_at !== args.run) return;
    const stoppedMeanwhile = current.status !== "running";
    const state: ReplayBackfill = stoppedMeanwhile ? { ...args.state, status: current.status, last_error: current.last_error } : args.state;
    await ctx.db.patch(source._id, { replay_backfill: state });
    if (args.lost) await markConnectionLost(ctx, source, args.lost);
    if (!stoppedMeanwhile && state.status === "running" && args.next_in_ms !== undefined) {
      await ctx.scheduler.runAfter(args.next_in_ms, internal.sources.replayBackfill.runPage, { source_id: source._id, run: args.run });
    }
  },
});

/** A vendor source the caller may change, or a refusal that says what to do instead. */
async function vendorSource(ctx: any, args: { source: string } & Record<string, any>): Promise<Doc<"event_sources">> {
  const { userId, workspaceKey } = await scopeOf(ctx, args);
  const source: Doc<"event_sources"> = await sourceByRef(ctx, userId, workspaceKey, args.source);
  if (!(VENDORS as readonly string[]).includes(source.provider)) invalidScope(`${source.name} is a ${source.provider} source: only PostHog and Sentry sources have recordings to import`);
  return source;
}

/**
 * `cast replay import` and the web's import button. A stopped import that
 * never finished continues from its cursor, unless another window is named or
 * `restart` is set; a running one is left alone. The source must be active.
 */
export const start = mutation({
  args: { ...scopeArgs, source: v.string(), window: v.optional(v.string()), restart: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    if (args.window !== undefined && !isReplayBackfillWindow(args.window)) invalidScope(`--since takes 7d, 30d, 90d or all, not "${args.window.slice(0, 20)}"`);
    const source = await vendorSource(ctx, args);
    if (source.status !== "active") {
      invalidScope(`${source.name} is ${source.status === "paused" ? "paused" : `stopped (${source.last_error ?? "error"})`}: resume it first (cast sources update ${source.name} --status active)`);
    }
    const now = Date.now();
    const current = source.replay_backfill;
    if (current?.status === "running" && !replayBackfillStalled(current, now) && !args.restart) {
      return { source: await sourceViewOf(ctx, source), started: false };
    }
    const window = (args.window as ReplayBackfill["window"] | undefined) ?? current?.window ?? DEFAULT_REPLAY_BACKFILL_WINDOW;
    const resume = !args.restart && replayBackfillResumes(current, now) && window === current!.window;
    const since = replayBackfillSince(window, now);
    const state: ReplayBackfill = resume
      ? { ...current!, status: "running", failures_in_row: 0, last_error: undefined, started_at: now, updated_at: now }
      : { status: "running", window, ...(since !== undefined ? { since } : {}), until: now, listed: 0, imported: 0, skipped: 0, failed: 0, started_at: now, updated_at: now };
    delete state.last_error;
    delete state.finished_at;
    await ctx.db.patch(source._id, { replay_backfill: state });
    await ctx.scheduler.runAfter(0, internal.sources.replayBackfill.runPage, { source_id: source._id, run: now });
    return { source: await sourceViewOf(ctx, (await ctx.db.get(source._id))!), started: true, resumed: resume };
  },
});

/** Stops a running import where it is; the next start continues from there. */
export const stop = mutation({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const source = await vendorSource(ctx, args);
    const current = source.replay_backfill;
    if (current?.status === "running") {
      await ctx.db.patch(source._id, { replay_backfill: { ...current, status: "paused", last_error: "Stopped", updated_at: Date.now() } });
    }
    return { source: await sourceViewOf(ctx, (await ctx.db.get(source._id))!) };
  },
});
