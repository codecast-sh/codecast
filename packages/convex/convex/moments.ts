// Bringing moments (docs/architecture/learning-loop.md LL3, LL7, LL8).
//
// 1. Intake. A product posts `{type: "moment", kind, subject, at, refs}`
//    through the ingest door. Each event lands on the one waiting moment of
//    its (kind, subject), which waits for the kind's quiet window after its
//    newest event, so a burst of messages in one conversation is judged once,
//    on its newest state.
// 2. Extraction. The product's repo publishes its extractors
//    (.codecast/moments/<kind>.ts) and judges (.codecast/judges/<name>.md)
//    from the machine that will run them. That machine's daemon claims due
//    moments, runs the extractor in the checkout, and hands back what it
//    printed.
// 3. Storage. The body stays on the host unless a person set the source's
//    moment storage to codecast, where it goes to R2 (the replays bucket):
//    for 30 days under the lifecycle rule on moments-30d/, or for good under
//    moments/ when the source's retention is keep (decision sd-555). The row
//    holds only what indexes it.
// 4. Judging. Each judge for the kind reads the moment in the same action,
//    from the body in hand, so a host-kept body is never written anywhere in
//    codecast. Every run is a judge_runs row; a live judge's findings file
//    through the signal door, where grouping places them (findingGroups.ts).

import { v } from "convex/values";
import { gzipSync, strToU8 } from "fflate";
import { action, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { nextShortId } from "./counters";
import { ownDevice } from "./devices";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf, sourceByRef } from "./lib/ingestScope";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { MOMENTS_30D_ROOT, MOMENTS_KEPT_ROOT, replaysBucketFromEnv } from "./lib/r2";
import { sha256Hex } from "./lib/hash";
import { agentJudgeFields, judgeInputs } from "./momentsSchema";
import { judgeRunRow, liveBodyKey, momentRefs, momentView, readKeptBody } from "./lib/momentBody";
import { putChunk } from "./replays";
import type { ModelCallResult } from "@codecast/shared/contracts/modelCall";
import { linesSince, renderExpectations, type ExpectationsVersion } from "@codecast/shared/contracts/expectations";
import {
  DEFAULT_QUIET_MS,
  MOMENT_LIMITS,
  momentWindow,
  momentWho,
  parseExtractorOutput,
  type ExtractorInput,
  type MomentEventItem,
  type MomentRecord,
  type MomentWindow,
} from "@codecast/shared/contracts/moments";
import { readRulings, type Ruling } from "./judgeRetire";
import { narrowBrief, type ExpectationsBrief, type JudgeHandoff } from "@codecast/shared/contracts/judges";
import { judgeMoment, prepareJudge, readingOf, settleJudge, type Finishing, type JudgeOutcome } from "./lib/momentJudging";

/** Moments one claim hands a host. */
const CLAIM_BATCH = 5;
/** Tries an extraction gets before the moment is failed. */
const EXTRACT_TRIES = 3;
/** A failed try waits this long before the next. */
const RETRY_AFTER_MS = 60_000;
/** Beyond the extractor's own timeout, the host's lease covers the hand back. */
const LEASE_SLACK_MS = 30_000;
/** Judges one moment may run. */
const JUDGES_PER_MOMENT = 10;
/** A waiting moment no extractor took, or a failed one, is dropped after this. */
const STALE_MS = MOMENT_LIMITS.retention_ms;

// ── 1. Intake ──

/**
 * The ingest batch's moment events (ingest.applyBatch), in its transaction:
 * each joins the waiting moment of its (kind, subject) whose events it falls
 * within the quiet window of, by the events' own times, or opens one. Live
 * events arrive at their own time, so this is the newest waiting moment; a
 * replay of history or a late batch keeps apart what happened apart. A moment
 * already being extracted is not reopened; the event opens the next.
 */
export async function recordMomentEvents(ctx: { db: any }, source: Doc<"event_sources">, items: MomentEventItem[], now: number, opts: { due_at?: number; batch?: string } = {}): Promise<number> {
  const quiet = new Map<string, number>();
  const quietOf = async (kind: string) => {
    if (!quiet.has(kind)) {
      const ex = await ctx.db.query("moment_extractors").withIndex("by_source_kind", (q: any) => q.eq("source_id", source._id).eq("kind", kind)).first();
      quiet.set(kind, ex?.quiet_ms ?? DEFAULT_QUIET_MS);
    }
    return quiet.get(kind)!;
  };
  let opened = 0;
  for (const item of items) {
    const quietMs = await quietOf(item.kind);
    const due = opts.due_at ?? now + quietMs;
    const refs = item.refs ? JSON.stringify(item.refs) : undefined;
    const waitingAll: Doc<"moments">[] = await ctx.db
      .query("moments")
      .withIndex("by_source_kind_subject_status", (q: any) => q.eq("source_id", source._id).eq("kind", item.kind).eq("subject", item.subject).eq("status", "waiting"))
      .take(200);
    const waiting = waitingAll.find((m) => item.at >= m.first_event_at - quietMs && item.at <= m.event_at + quietMs) ?? null;
    if (waiting) {
      const newest = item.at >= waiting.event_at;
      await ctx.db.patch(waiting._id, {
        events: waiting.events + 1,
        first_event_at: Math.min(waiting.first_event_at, item.at),
        event_at: Math.max(waiting.event_at, item.at),
        ...(newest && refs ? { refs_json: refs } : {}),
        ...(opts.batch ? { batch: opts.batch } : {}),
        due_at: opts.due_at ?? Math.max(waiting.due_at, due),
        updated_at: now,
      });
      continue;
    }
    await ctx.db.insert("moments", {
      workspace: source.workspace,
      ...(source.team_id ? { team_id: source.team_id } : {}),
      source_id: source._id,
      ...(source.project_id ? { project_id: source.project_id } : {}),
      short_id: await nextShortId(ctx.db, "mo"),
      kind: item.kind,
      subject: item.subject,
      status: "waiting",
      events: 1,
      first_event_at: item.at,
      event_at: item.at,
      ...(refs ? { refs_json: refs } : {}),
      ...(opts.batch ? { batch: opts.batch } : {}),
      due_at: due,
      attempts: 0,
      storage: source.config?.moment_storage ?? "host",
      created_at: now,
      updated_at: now,
    });
    opened++;
  }
  return opened;
}

/**
 * What is new in a moment (MomentWindow): from just after the newest earlier
 * moment of its kind and subject (one that failed was never judged, so it
 * does not count), else from its first event less the quiet window; to its
 * newest event, or when its facts were read.
 */
async function windowOf(ctx: { db: any }, m: Doc<"moments">, quietMs: number, readAt?: number): Promise<MomentWindow> {
  const rows: Doc<"moments">[] = await ctx.db
    .query("moments")
    .withIndex("by_source_kind_subject_status", (q: any) => q.eq("source_id", m.source_id).eq("kind", m.kind).eq("subject", m.subject))
    .take(500);
  const before = rows.filter((r) => r._id !== m._id && r.status !== "failed" && r.event_at < m.first_event_at).map((r) => r.event_at);
  return momentWindow(m, { previous_event_at: before.length ? Math.max(...before) : null, quiet_ms: quietMs, read_at: readAt });
}

// ── 2. Publish: a repo's extractors and judges ──

const extractorArg = v.object({ kind: v.string(), path: v.string(), version: v.string(), quiet_ms: v.number(), timeout_ms: v.number() });
const judgeArg = v.object({
  name: v.string(),
  path: v.string(),
  version: v.string(),
  moment: v.string(),
  model: v.string(),
  max_tokens: v.number(),
  projects: v.array(v.string()),
  parts: v.optional(v.array(v.string())),
  mode: v.union(v.literal("shadow"), v.literal("live")),
  prompt: v.string(),
  agent: v.optional(agentJudgeFields),
});

/**
 * `cast line moments publish`: the whole set a checkout holds for one source.
 * Extractors run on the publishing machine; a kind the publish no longer
 * carries stops being extracted, and a judge it no longer carries stops
 * running (its runs stay).
 */
export const publish = mutation({
  args: { ...scopeArgs, source: v.string(), device_id: v.string(), root: v.string(), extractors: v.array(extractorArg), judges: v.array(judgeArg) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = await sourceByRef(ctx, userId, workspaceKey, args.source);
    if (!(await ownDevice(ctx, userId, args.device_id))) throw new Error("Publish from a machine signed in as you: extractors run where they are published");
    const now = Date.now();

    const kinds = new Set(args.extractors.map((e) => e.kind));
    const existing: Doc<"moment_extractors">[] = await ctx.db.query("moment_extractors").withIndex("by_source_kind", (q: any) => q.eq("source_id", source._id)).collect();
    for (const row of existing) if (!kinds.has(row.kind)) await ctx.db.delete(row._id);
    for (const e of args.extractors) {
      const row = existing.find((r) => r.kind === e.kind);
      const fields = { ...e, device_id: args.device_id, root: args.root, publisher_user_id: userId, published_at: now };
      if (row) await ctx.db.patch(row._id, fields);
      else await ctx.db.insert("moment_extractors", { workspace: source.workspace, source_id: source._id, ...fields });
    }

    const names = new Set(args.judges.map((j) => j.name));
    const judges: Doc<"judges">[] = await ctx.db.query("judges").withIndex("by_source_name", (q: any) => q.eq("source_id", source._id)).collect();
    for (const row of judges) if (!names.has(row.name) && !row.removed_at) await ctx.db.patch(row._id, { removed_at: now });
    const problems: string[] = [];
    for (const j of args.judges) {
      const projectIds: Id<"projects">[] = [];
      for (const ref of j.projects) {
        const project = await resolveWorkspaceProject(ctx, source.workspace, ref);
        if (project) projectIds.push(project._id);
        else problems.push(`${j.name}: no project "${ref}" in the source's workspace`);
      }
      if (!kinds.has(j.moment)) problems.push(`${j.name}: no extractor for moment kind "${j.moment}" (.codecast/moments/${j.moment}.ts)`);
      // A review runs wherever a machine claims it, so it reads the moment from codecast, never from the extracting host.
      if (j.agent && (source.config?.moment_storage ?? "host") !== "codecast") problems.push(`${j.name}: an agent judge reads moments kept in codecast; set it with cast sources set ${source.name} --moment-storage codecast`);
      const { moment, ...rest } = j;
      const fields = { ...rest, parts: rest.parts, agent: rest.agent, moment_kind: moment, project_ids: projectIds, publisher_user_id: userId, published_at: now, removed_at: undefined };
      const row = judges.find((r) => r.name === j.name);
      if (row) await ctx.db.patch(row._id, fields);
      else await ctx.db.insert("judges", { workspace: source.workspace, ...(source.team_id ? { team_id: source.team_id } : {}), source_id: source._id, ...fields });
    }
    return { source: source.name, storage: source.config?.moment_storage ?? "host", extractors: args.extractors.length, judges: args.judges.length, problems };
  },
});

// ── 3. Extraction on the host ──

export type MomentClaim = {
  moment: string;
  source: string;
  input: ExtractorInput;
  extractor: { path: string; root: string; version: string; timeout_ms: number };
  storage: "host" | "codecast";
};

/**
 * The daemon's claim (`/cli/moments/claim`): due moments of the extractors
 * this machine published, leased until the extractor's timeout passes. A
 * lease that ran out goes again, up to EXTRACT_TRIES, then fails.
 */
export const claim = mutation({
  args: { api_token: v.string(), device_id: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<MomentClaim[]> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth || !(await ownDevice(ctx, auth.userId, args.device_id))) throw new Error("Unauthorized");
    const now = Date.now();
    const limit = Math.min(Math.max(1, args.limit ?? CLAIM_BATCH), 20);
    const extractors: Doc<"moment_extractors">[] = await ctx.db.query("moment_extractors").withIndex("by_device", (q: any) => q.eq("device_id", args.device_id)).collect();
    const out: MomentClaim[] = [];
    for (const ex of extractors) {
      if (out.length >= limit || ex.publisher_user_id !== auth.userId) continue;
      const source = await ctx.db.get(ex.source_id);
      if (!source || source.status === "paused") continue;
      for (const status of ["waiting", "extracting"] as const) {
        const due: Doc<"moments">[] = await ctx.db
          .query("moments")
          .withIndex("by_source_kind_status_due", (q: any) => q.eq("source_id", ex.source_id).eq("kind", ex.kind).eq("status", status).lte("due_at", now))
          .take(limit);
        // Where the body goes is the source's setting when it is read, not when its first event came.
        const storage = source.config?.moment_storage ?? "host";
        for (const m of due) {
          if (out.length >= limit) break;
          if (m.attempts >= EXTRACT_TRIES) {
            await ctx.db.patch(m._id, { status: "failed", error: m.error ?? "the extractor did not hand a moment back in three tries", updated_at: now });
            continue;
          }
          await ctx.db.patch(m._id, { status: "extracting", claim_device: args.device_id, attempts: m.attempts + 1, due_at: now + ex.timeout_ms + LEASE_SLACK_MS, storage, updated_at: now });
          out.push({
            moment: m.short_id,
            source: source.name,
            input: { kind: m.kind, subject: m.subject, at: m.event_at, refs: m.refs_json ? JSON.parse(m.refs_json) : {}, events: m.events, moment: m.short_id, window: await windowOf(ctx, m, ex.quiet_ms) },
            extractor: { path: ex.path, root: ex.root, version: ex.version, timeout_ms: ex.timeout_ms },
            storage,
          });
        }
      }
    }
    return out;
  },
});

const liveJudges = async (ctx: any, m: Doc<"moments">): Promise<Doc<"judges">[]> =>
  (await ctx.db.query("judges").withIndex("by_source_kind", (q: any) => q.eq("source_id", m.source_id).eq("moment_kind", m.kind)).collect())
    .filter((j: Doc<"judges">) => !j.removed_at)
    .slice(0, JUDGES_PER_MOMENT);

/** The claim being handed back, checked: still leased to this machine and its person. */
export const finishing = internalQuery({
  args: { api_token: v.string(), device_id: v.string(), moment: v.string() },
  handler: async (ctx, args): Promise<Finishing> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const moment = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment)).first();
    if (!moment || moment.status !== "extracting" || moment.claim_device !== args.device_id) throw new Error(`${args.moment} is not leased to this machine`);
    const ex = await ctx.db.query("moment_extractors").withIndex("by_source_kind", (q: any) => q.eq("source_id", moment.source_id).eq("kind", moment.kind)).first();
    if (!ex || ex.publisher_user_id !== auth.userId) throw new Error("Unauthorized");
    const source = (await ctx.db.get(moment.source_id))!;
    return { moment, source, judges: await liveJudges(ctx, moment), window: await windowOf(ctx, moment, ex.quiet_ms) };
  },
});

// Both hand back writes land only while the moment is still leased: a second
// hand back of one claim (a retried request, an older lease) finds it settled
// and changes nothing, so a moment is judged once and a late failure never
// sends a ready moment round again.
export const markFailed = internalMutation({
  args: { moment_id: v.id("moments"), error: v.string(), retry: v.boolean() },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.moment_id);
    if (!m || m.status !== "extracting") return;
    const now = Date.now();
    const again = args.retry && m.attempts < EXTRACT_TRIES;
    await ctx.db.patch(m._id, { status: again ? "waiting" : "failed", error: args.error.slice(0, 500), due_at: again ? now + RETRY_AFTER_MS : m.due_at, claim_device: undefined, updated_at: now });
  },
});

export const markReady = internalMutation({
  args: {
    moment_id: v.id("moments"),
    extractor_version: v.string(),
    extracted_at: v.number(),
    gap_ms: v.number(),
    blocks: v.number(),
    body_bytes: v.number(),
    body_key: v.optional(v.string()),
    /** Absent for a source that keeps its bodies. */
    body_expires_at: v.optional(v.number()),
    who: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const m = await ctx.db.get(args.moment_id);
    if (!m || m.status !== "extracting") return false;
    await ctx.db.patch(m._id, {
      status: "ready",
      who: args.who,
      extractor_version: args.extractor_version,
      extracted_at: args.extracted_at,
      gap_ms: args.gap_ms,
      blocks: args.blocks,
      body_bytes: args.body_bytes,
      ...(args.body_key ? { body_key: args.body_key, body_expires_at: args.body_expires_at } : {}),
      error: undefined,
      claim_device: undefined,
      // The scope travels to this judging in the claim's snapshot (complete); the next reading is whole again.
      rejudge_lines: undefined,
      updated_at: Date.now(),
    });
    return true;
  },
});

/** Where a codecast-stored body lives in the replays bucket: under its retention's prefix and its source, content addressed. */
export function momentBodyKey(sourceId: string, shortId: string, sha: string, keep: boolean): string {
  return `${keep ? MOMENTS_KEPT_ROOT : MOMENTS_30D_ROOT}${sourceId}/${shortId}-${sha}.json.gz`;
}

/**
 * The host hands a claim back (`/cli/moments/complete`): the extractor's
 * output, or why it failed. A good moment is stored where its source says,
 * then judged in this action from the body in hand.
 */
export const complete = action({
  args: {
    api_token: v.string(),
    device_id: v.string(),
    moment: v.string(),
    extractor_version: v.string(),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ moment: string; status: "ready" | "failed" | "waiting"; storage?: string; judged?: JudgeOutcome[]; judge_here?: JudgeHandoff; error?: string }> => {
    const f: Finishing = await ctx.runQuery(internal.moments.finishing, { api_token: args.api_token, device_id: args.device_id, moment: args.moment });
    if (args.error !== undefined || args.output === undefined) {
      const error = args.error || "the extractor printed nothing";
      await ctx.runMutation(internal.moments.markFailed, { moment_id: f.moment._id, error, retry: true });
      return { moment: args.moment, status: f.moment.attempts < EXTRACT_TRIES ? "waiting" : "failed", error };
    }
    const parsed = parseExtractorOutput(args.output);
    if ("error" in parsed) {
      // The same code on the same data prints the same thing: no retry.
      await ctx.runMutation(internal.moments.markFailed, { moment_id: f.moment._id, error: parsed.error, retry: false });
      return { moment: args.moment, status: "failed", error: parsed.error };
    }
    const extractedAt = Date.now();
    // An extractor that reads as of an earlier time (a replay's refs.as_of)
    // says so in its `at`: its facts are as of then, and the judge reads them then.
    const factsAt = Math.min(extractedAt, parsed.at ?? extractedAt);
    const record: MomentRecord = {
      ...parsed,
      kind: f.moment.kind,
      subject: f.moment.subject,
      event_at: f.moment.event_at,
      extracted_at: extractedAt,
      gap_ms: Math.max(0, factsAt - f.moment.event_at),
      extractor: { path: `.codecast/moments/${f.moment.kind}.ts`, version: args.extractor_version },
      window: { from: f.window.from, to: Math.max(f.window.to, factsAt) },
    };
    const json = JSON.stringify(record);
    const storage = f.moment.storage ?? "host";
    let bodyKey: string | undefined;
    const keep = f.source.config?.moment_retention === "keep";
    if (storage === "codecast") {
      const bucket = replaysBucketFromEnv();
      if (!bucket) {
        await ctx.runMutation(internal.moments.markFailed, { moment_id: f.moment._id, error: "moment storage is not configured (REPLAYS_R2_*)", retry: true });
        return { moment: args.moment, status: "waiting", error: "storage is not configured" };
      }
      bodyKey = momentBodyKey(String(f.moment.source_id), f.moment.short_id, await sha256Hex(json), keep);
      await putChunk(bucket, bodyKey, gzipSync(strToU8(json)));
    }
    const won: boolean = await ctx.runMutation(internal.moments.markReady, {
      moment_id: f.moment._id,
      extractor_version: args.extractor_version,
      extracted_at: extractedAt,
      gap_ms: record.gap_ms,
      blocks: record.blocks.length,
      body_bytes: json.length,
      ...(momentWho(record) ? { who: momentWho(record)! } : {}),
      ...(bodyKey ? { body_key: bodyKey, ...(keep ? {} : { body_expires_at: extractedAt + MOMENT_LIMITS.retention_ms }) } : {}),
    });
    // Another hand back of this claim already settled it, and judged it.
    if (!won) return { moment: args.moment, status: "ready", storage };
    const { judged, handoff } = await judgeMoment(ctx, f, record, f.moment.rejudge_lines);
    return { moment: args.moment, status: "ready", storage, judged, ...(handoff ? { judge_here: handoff } : {}) };
  },
});

// ── 4. Judging ──

/** The expectations each project is graded against, at its current version. */
export const briefsFor = internalQuery({
  args: { project_ids: v.array(v.id("projects")), parts: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<Array<ExpectationsBrief & { project_id: Id<"projects"> }>> => {
    const out: Array<ExpectationsBrief & { project_id: Id<"projects"> }> = [];
    for (const id of args.project_ids) {
      const project = await ctx.db.get(id);
      if (!project) continue;
      const row = await ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => q.eq("project_id", id)).order("desc").first();
      if (!row) continue;
      const doc: ExpectationsVersion = { project: { id: String(id), title: project.title }, version: row.version, prefix: row.prefix, items: row.items, applied_at: row.created_at, how: row.how, summary: row.summary };
      out.push(narrowBrief({
        project_id: id,
        project: project.title,
        version: row.version,
        text: renderExpectations(doc, { brief: true }),
        ids: row.items.filter((e: any) => e.status === "active").map((e: any) => e.id),
        since: linesSince(row.items),
      }, args.parts));
    }
    return out;
  },
});

export const recordRun = internalMutation({
  args: {
    judge_id: v.id("judges"),
    moment_id: v.id("moments"),
    status: v.union(v.literal("ok"), v.literal("failed"), v.literal("skipped")),
    reason: v.optional(v.string()),
    expectations: v.array(v.object({ project_id: v.id("projects"), version: v.number() })),
    findings_json: v.optional(v.string()),
    findings: v.number(),
    uncited: v.optional(v.number()),
    signal_ids: v.optional(v.array(v.id("signals"))),
    held_ids: v.optional(v.array(v.id("signals"))),
    waiting: v.optional(v.array(v.string())),
    inputs: v.optional(judgeInputs),
    lines: v.optional(v.array(v.string())),
    model: v.string(),
    backend: v.optional(v.literal("subscription")),
    cost_usd: v.number(),
  },
  handler: async (ctx, args) => {
    const judge = await ctx.db.get(args.judge_id);
    const moment = await ctx.db.get(args.moment_id);
    if (!judge || !moment) return null;
    const now = Date.now();
    const { judge_id, moment_id, ...rest } = args;
    const id = await ctx.db.insert("judge_runs", {
      workspace: moment.workspace,
      ...(moment.team_id ? { team_id: moment.team_id } : {}),
      source_id: moment.source_id,
      judge_id,
      judge: judge.name,
      judge_version: judge.version,
      moment_id,
      moment_short_id: moment.short_id,
      mode: judge.mode,
      ...rest,
      at: now,
    });
    await ctx.db.patch(moment._id, { judged_at: now });
    return id;
  },
});

/**
 * A moment whose judging was handed to a machine, being handed back
 * (`/cli/moments/judged`): checked as its hand-in was. The daemon that
 * extracted it names its device, which must still be the one its extractor
 * runs on; a person's `cast line moments rejudge` names their workspace.
 * Either way the source must judge on subscription.
 */
export const judgedFinishing = internalQuery({
  args: { ...scopeArgs, device_id: v.optional(v.string()), moment: v.string() },
  handler: async (ctx, args): Promise<Finishing> => {
    const moment = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment.trim())).first();
    if (!moment || moment.status !== "ready") throw new Error(`${args.moment} is not a ready moment`);
    const ex = await ctx.db.query("moment_extractors").withIndex("by_source_kind", (q: any) => q.eq("source_id", moment.source_id).eq("kind", moment.kind)).first();
    if (args.device_id) {
      const auth = await verifyApiToken(ctx, args.api_token ?? "");
      if (!auth || !ex || ex.device_id !== args.device_id || ex.publisher_user_id !== auth.userId) throw new Error("Unauthorized");
    } else {
      const { workspaceKey } = await scopeOf(ctx, args);
      if (moment.workspace !== workspaceKey) throw new Error(`No moment ${args.moment} in this workspace`);
    }
    const source = (await ctx.db.get(moment.source_id))!;
    if (source.config?.judge_on !== "subscription") throw new Error(`${source.name} judges on the API; a judgment made elsewhere is not taken`);
    return { moment, source, judges: await liveJudges(ctx, moment), window: await windowOf(ctx, moment, ex?.quiet_ms ?? DEFAULT_QUIET_MS) };
  },
});

const judgedResult = v.object({
  ok: v.boolean(),
  text: v.optional(v.string()),
  error: v.optional(v.string()),
  input_tokens: v.optional(v.number()),
  output_tokens: v.optional(v.number()),
  stop_reason: v.optional(v.union(v.string(), v.null())),
});

/**
 * The replies to a JudgeHandoff (`/cli/moments/judged`), each settled as an
 * API reply is. The request is prepared again from the record and clock the
 * handoff carried, so what is graded and recorded is what was asked; a judge
 * the handoff did not ask, or one removed since, is passed over.
 */
export const judgedForCli = action({
  args: {
    ...scopeArgs,
    device_id: v.optional(v.string()),
    moment: v.string(),
    clock: v.number(),
    lines: v.optional(v.array(v.string())),
    /** The MomentRecord the handoff carried, as JSON. */
    record: v.string(),
    results: v.array(v.object({ judge: v.string(), result: judgedResult })),
  },
  handler: async (ctx, args): Promise<{ moment: string; judged: JudgeOutcome[] }> => {
    const { moment, clock, lines, record: recordJson, results, device_id, ...scope } = args;
    const f: Finishing = await ctx.runQuery(internal.moments.judgedFinishing, { ...scope, ...(device_id ? { device_id } : {}), moment });
    const record = JSON.parse(recordJson) as MomentRecord;
    if (record.kind !== f.moment.kind || record.subject !== f.moment.subject) throw new Error(`the record handed back is not ${moment}'s`);
    const reading = await readingOf(ctx, f, record, lines, clock);
    const judged: JudgeOutcome[] = [];
    for (const { judge: name, result: r } of results) {
      const judge = f.judges.find((j) => j.name === name);
      if (!judge) continue;
      const p = await prepareJudge(ctx, f, record, judge, reading);
      if ("outcome" in p) { judged.push(p.outcome); continue; }
      const result: ModelCallResult = r.ok && r.text !== undefined
        ? { ok: true, text: r.text, usage: { input_tokens: r.input_tokens ?? 0, output_tokens: r.output_tokens ?? 0 }, cost_usd: 0, model: judge.model, stop_reason: r.stop_reason ?? null }
        : { ok: false, reason: "failed", error: (r.error || "the subscription call gave no answer").slice(0, 500), cost_usd: 0, model: judge.model };
      judged.push(await settleJudge(ctx, f, record, p, result, reading, "subscription"));
    }
    return { moment, judged };
  },
});

// ── Reads ──

/** `cast line moments ls`: the workspace's newest moments, and its extractors and judges. */
export const listForCli = query({
  args: { ...scopeArgs, source: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = args.source ? await sourceByRef(ctx, userId, workspaceKey, args.source) : null;
    const rows: Doc<"moments">[] = await ctx.db.query("moments").withIndex("by_workspace_created", (q: any) => q.eq("workspace", workspaceKey)).order("desc").take(Math.min(args.limit ?? 30, 200) * (source ? 4 : 1));
    const moments = rows.filter((m) => !source || m.source_id === source._id).slice(0, Math.min(args.limit ?? 30, 200));
    const sources = source ? [source] : await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspaceKey)).collect();
    const extractors = [];
    const judges = [];
    const findings = [];
    for (const s of sources) {
      const ex: Doc<"moment_extractors">[] = await ctx.db.query("moment_extractors").withIndex("by_source_kind", (q: any) => q.eq("source_id", s._id)).collect();
      for (const e of ex) extractors.push({ source: s.name, kind: e.kind, version: e.version, quiet_ms: e.quiet_ms, published_at: e.published_at });
      const live: Doc<"judges">[] = (await ctx.db.query("judges").withIndex("by_source_name", (q: any) => q.eq("source_id", s._id)).collect()).filter((j: Doc<"judges">) => !j.removed_at);
      for (const j of live) judges.push({ source: s.name, name: j.name, version: j.version, moment: j.moment_kind, model: j.model, mode: j.mode, projects: j.projects, judge_on: s.config?.judge_on ?? "api" });
      if (live.length) findings.push({ source: s.name, ...(await findingFreshness(ctx, s._id, ex, live)) });
    }
    return { moments: moments.map((m) => momentView(m, Date.now())), extractors, judges, findings };
  },
});

/**
 * How current a source's live findings are: each judge finding not retired,
 * merged or a case against its judge, in its judges' projects, against the published versions. A
 * finding is stale when the judge version that filed (or last re-found) it is
 * not its judge's published one, or a moment standing behind it (the one it
 * came from, or another showing the same evidence whose newest run still files
 * it) was read by an extractor that is not its kind's published one. Stale findings make a
 * board that shows what an older extractor or judge believed; `stale_moments`
 * are the moments to read again (`cast line moments retry --again`).
 */
async function findingFreshness(ctx: any, sourceId: Id<"event_sources">, extractors: Doc<"moment_extractors">[], judges: Doc<"judges">[]) {
  const judgeVersion = new Map(judges.map((j) => [j.name, j.version]));
  const extractorVersion = new Map(extractors.map((e) => [e.kind, e.version]));
  const projects = [...new Set(judges.flatMap((j) => j.project_ids.map(String)))] as Id<"projects">[];
  const rows: Doc<"signals">[] = [];
  for (const p of projects) rows.push(...(await ctx.db.query("signals").withIndex("by_project_created", (q: any) => q.eq("project_id", p)).collect()));
  // A case against a judge (case_of, LL11) is the judge's defect, not a finding on the board.
  const judged = rows.filter((s) => s.judge && judgeVersion.has(s.judge) && s.moment && !s.retired && !s.merged_into && !s.case_of);
  const moments = new Map<string, Doc<"moments"> | null>();
  // The moments standing behind a finding: the one that filed it and every other whose newest run still files it (held_by).
  const behind = (s: Doc<"signals">) => [...new Set([s.moment!, ...(s.held_by ?? [])])];
  for (const ref of new Set(judged.flatMap(behind))) moments.set(ref, await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first());
  const live = judged.filter((s) => { const m = moments.get(s.moment!); return !m || String(m.source_id) === String(sourceId); });
  let staleJudge = 0;
  let staleExtractor = 0;
  let stale = 0;
  const staleMoments = new Set<string>();
  for (const s of live) {
    const oldJudge = s.judge_version !== judgeVersion.get(s.judge!);
    const readOld = behind(s).map((ref) => moments.get(ref)).filter((m): m is Doc<"moments"> => !!m && m.extractor_version !== extractorVersion.get(m.kind));
    if (oldJudge) staleJudge++;
    if (readOld.length) staleExtractor++;
    if (oldJudge || readOld.length) stale++;
    for (const m of readOld) staleMoments.add(m.short_id);
    const own = moments.get(s.moment!);
    if (oldJudge && own) staleMoments.add(own.short_id);
  }
  return { live: live.length, stale, stale_judge: staleJudge, stale_extractor: staleExtractor, stale_moments: [...staleMoments].sort() };
}

/** `cast line moments show <mo-N>`: one moment and every judge's run on it. */
export const showForCli = query({
  args: { ...scopeArgs, moment: v.string() },
  handler: async (ctx, args) => {
    const { workspaceKey } = await scopeOf(ctx, args);
    const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment.trim())).first();
    if (!m || m.workspace !== workspaceKey) throw new Error(`No moment ${args.moment} in this workspace`);
    const source = await ctx.db.get(m.source_id);
    const runs = await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect();
    return {
      moment: { ...momentView(m, Date.now()), source: source?.name, refs: momentRefs(m) },
      runs: runs.map((r: Doc<"judge_runs">) => ({ ...judgeRunRow(r), expectations: r.expectations.map((e) => e.version) })),
    };
  },
});

/**
 * `cast line moments retry <mo-N>…`: a failed moment goes round again, its
 * tries reset and due now, for when what failed it (a missing key, a broken
 * extractor) is fixed. Only a failed moment; any other is left as it is.
 * With `again`, a ready moment goes round too: read again by its kind's
 * current extractor and judged again, the judges' earlier findings on it
 * retiring where they are not found again (judgeRetire.ts). `lines` names the
 * expectations whose facts the extractor change touched: that judging files
 * and lets go only under them, so a resample of every other line moves nothing.
 */
export const retryForCli = mutation({
  args: { ...scopeArgs, moments: v.array(v.string()), again: v.optional(v.boolean()), lines: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const { workspaceKey } = await scopeOf(ctx, args);
    const now = Date.now();
    const out: Array<{ moment: string; status: string; retried: boolean }> = [];
    for (const ref of args.moments.slice(0, 200)) {
      const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", ref.trim())).first();
      if (!m || m.workspace !== workspaceKey) throw new Error(`No moment ${ref} in this workspace`);
      if (m.status !== "failed" && !(args.again && m.status === "ready")) {
        out.push({ moment: m.short_id, status: m.status, retried: false });
        continue;
      }
      await ctx.db.patch(m._id, { status: "waiting", attempts: 0, error: undefined, due_at: now, claim_device: undefined, rejudge_lines: args.lines?.length ? args.lines : undefined, updated_at: now });
      out.push({ moment: m.short_id, status: "waiting", retried: true });
    }
    return out;
  },
});

/** A ready moment as `cast line moments rejudge` reads it: its judges, its window and where its kept body is. */
export const rejudging = internalQuery({
  args: { ...scopeArgs, moment: v.string() },
  handler: async (ctx, args): Promise<(Finishing & { body_key: string | null }) | { error: string }> => {
    const { workspaceKey } = await scopeOf(ctx, args);
    const moment = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment.trim())).first();
    if (!moment || moment.workspace !== workspaceKey) throw new Error(`No moment ${args.moment} in this workspace`);
    if (moment.status !== "ready") return { error: `${moment.short_id} is ${moment.status}; only a ready moment is judged again` };
    const ex = await ctx.db.query("moment_extractors").withIndex("by_source_kind", (q: any) => q.eq("source_id", moment.source_id).eq("kind", moment.kind)).first();
    const source = (await ctx.db.get(moment.source_id))!;
    const kept = !!moment.body_key && (moment.body_expires_at == null || moment.body_expires_at > Date.now());
    return { moment, source, judges: await liveJudges(ctx, moment), window: await windowOf(ctx, moment, ex?.quiet_ms ?? DEFAULT_QUIET_MS), body_key: kept ? moment.body_key! : null };
  },
});

/**
 * `cast line moments rejudge <mo-N>…`: ready moments whose bodies codecast
 * keeps are judged again by their kind's current judges, read with their
 * window. Each judge's earlier findings on the moment that it does not find
 * again leave their problems (judgeRetire.ts), so a judge's new version
 * replaces what its old one filed rather than adding beside it. `lines`
 * scopes it as retryForCli's does.
 */
export const rejudgeForCli = action({
  args: { ...scopeArgs, moments: v.array(v.string()), lines: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<Array<{ moment: string; judged?: JudgeOutcome[]; judge_here?: JudgeHandoff; error?: string }>> => {
    const { moments, lines, ...scope } = args;
    const out: Array<{ moment: string; judged?: JudgeOutcome[]; judge_here?: JudgeHandoff; error?: string }> = [];
    for (const ref of moments.slice(0, 5)) {
      const r = await ctx.runQuery(internal.moments.rejudging, { ...scope, moment: ref });
      if ("error" in r) { out.push({ moment: ref, error: r.error }); continue; }
      const body = await readKeptBody(r.body_key);
      if (!body) { out.push({ moment: ref, error: "codecast does not keep this moment's body (host storage, or past its 30 days)" }); continue; }
      const { body_key: _, ...f } = r;
      const record: MomentRecord = { ...body, window: { from: f.window.from, to: Math.max(f.window.to, body.at ?? body.event_at) } };
      const { judged, handoff } = await judgeMoment(ctx, f, record, lines);
      out.push({ moment: ref, judged, ...(handoff ? { judge_here: handoff } : {}) });
    }
    return out;
  },
});

/** The team's rulings on any message filed under these evidence scopes (judges.evidenceScopes), so a judge tried off the server reads what a published one reads (`cast line judges ab`). */
export const rulingsForCli = query({
  args: { ...scopeArgs, scopes: v.array(v.string()) },
  handler: async (ctx, args): Promise<Ruling[]> => {
    const { workspaceKey } = await scopeOf(ctx, args);
    return await readRulings(ctx, workspaceKey, args.scopes.filter((s) => s.startsWith("evidence:")).slice(0, 20));
  },
});

export const bodyKeyFor = internalQuery({
  args: { ...scopeArgs, moment: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const { workspaceKey } = await scopeOf(ctx, args);
    const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment.trim())).first();
    if (!m || m.workspace !== workspaceKey) throw new Error(`No moment ${args.moment} in this workspace`);
    return liveBodyKey(m, Date.now());
  },
});

/** A codecast-stored moment's body, for `cast line moments show --body`. Null when the body is on the host or its 30 days are up. */
export const bodyForCli = action({
  args: { ...scopeArgs, moment: v.string() },
  handler: async (ctx, args): Promise<MomentRecord | null> => {
    return readKeptBody(await ctx.runQuery(internal.moments.bodyKeyFor, args));
  },
});

// ── Upkeep ──

/**
 * Daily: a 30-day body past its days is gone from R2 (the lifecycle rule on
 * moments-30d/), so its row stops pointing at it; a kept body has no expiry
 * and is never touched. A moment no extractor ever took, or one that failed,
 * is dropped after 30 days. Judge runs stay.
 */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let cleared = 0;
    let dropped = 0;
    const expired = await ctx.db.query("moments").withIndex("by_body_expires", (q: any) => q.gt("body_expires_at", 0).lte("body_expires_at", now)).take(500);
    for (const m of expired) {
      await ctx.db.patch(m._id, { body_key: undefined, body_expires_at: undefined });
      cleared++;
    }
    for (const status of ["waiting", "failed"] as const) {
      const stale = await ctx.db.query("moments").withIndex("by_status_due", (q: any) => q.eq("status", status).lte("due_at", now - STALE_MS)).take(500);
      for (const m of stale) {
        await ctx.db.delete(m._id);
        dropped++;
      }
    }
    return { cleared, dropped };
  },
});

/**
 * A source switched to keep (ingest.updateSource): its bodies still in R2
 * under moments/, which no lifecycle rule covers, lose their expiry so prune
 * never unhooks them. One page of still-expiring rows per run, then the next.
 * A body under moments-30d/ keeps its date: the bucket deletes it regardless.
 */
export const keepBodies = internalMutation({
  args: { source_id: v.id("event_sources"), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const page = await ctx.db
      .query("moments")
      .withIndex("by_body_expires", (q: any) => q.gt("body_expires_at", 0))
      .paginate({ cursor: args.cursor ?? null, numItems: 500 });
    let kept = 0;
    for (const m of page.page as Doc<"moments">[]) {
      // A body already past its date is gone from R2: prune unhooks it.
      if (m.source_id !== args.source_id || !m.body_key?.startsWith(MOMENTS_KEPT_ROOT) || m.body_expires_at! <= now) continue;
      await ctx.db.patch(m._id, { body_expires_at: undefined });
      kept++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.moments.keepBodies, { source_id: args.source_id, cursor: page.continueCursor });
    return { kept };
  },
});
