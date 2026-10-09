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
//    moment storage to codecast, where it is kept 30 days in R2 (the replays
//    bucket and its lifecycle rule). The row holds only what indexes it.
// 4. Judging. Each judge for the kind reads the moment in the same action,
//    from the body in hand, so a host-kept body is never written anywhere in
//    codecast. Every run is a judge_runs row; a live judge's findings file
//    through the signal door, where grouping places them (findingGroups.ts).

import { v } from "convex/values";
import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";
import { action, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { nextShortId } from "./counters";
import { ownDevice } from "./devices";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf, sourceByRef } from "./lib/ingestScope";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { replaysBucketFromEnv, r2Presign } from "./lib/r2";
import { sha256Hex } from "./lib/hash";
import { putChunk } from "./replays";
import { runModelCall } from "./modelCalls";
import { renderExpectations, type ExpectationsVersion } from "@codecast/shared/contracts/expectations";
import {
  DEFAULT_QUIET_MS,
  MOMENT_LIMITS,
  parseExtractorOutput,
  type ExtractorInput,
  type MomentEventItem,
  type MomentRecord,
} from "@codecast/shared/contracts/moments";
import { findingSignal, judgeRequest, parseJudgeReply, type ExpectationsBrief, type JudgeFinding, type JudgeSpec } from "@codecast/shared/contracts/judges";

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
 * each joins the waiting moment of its (kind, subject), or opens one. A
 * moment already being extracted is not reopened; the event opens the next.
 */
export async function recordMomentEvents(ctx: { db: any }, source: Doc<"event_sources">, items: MomentEventItem[], now: number): Promise<number> {
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
    const due = now + (await quietOf(item.kind));
    const refs = item.refs ? JSON.stringify(item.refs) : undefined;
    const waiting: Doc<"moments"> | null = await ctx.db
      .query("moments")
      .withIndex("by_source_kind_subject_status", (q: any) => q.eq("source_id", source._id).eq("kind", item.kind).eq("subject", item.subject).eq("status", "waiting"))
      .first();
    if (waiting) {
      const newest = item.at >= waiting.event_at;
      await ctx.db.patch(waiting._id, {
        events: waiting.events + 1,
        first_event_at: Math.min(waiting.first_event_at, item.at),
        event_at: Math.max(waiting.event_at, item.at),
        ...(newest && refs ? { refs_json: refs } : {}),
        due_at: Math.max(waiting.due_at, due),
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
  mode: v.union(v.literal("shadow"), v.literal("live")),
  prompt: v.string(),
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
      const { moment, ...rest } = j;
      const fields = { ...rest, moment_kind: moment, project_ids: projectIds, publisher_user_id: userId, published_at: now, removed_at: undefined };
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
          .withIndex("by_source_status_due", (q: any) => q.eq("source_id", ex.source_id).eq("status", status).lte("due_at", now))
          .take(limit * 2);
        for (const m of due) {
          if (out.length >= limit) break;
          if (m.kind !== ex.kind) continue;
          if (m.attempts >= EXTRACT_TRIES) {
            await ctx.db.patch(m._id, { status: "failed", error: m.error ?? "the extractor did not hand a moment back in three tries", updated_at: now });
            continue;
          }
          await ctx.db.patch(m._id, { status: "extracting", claim_device: args.device_id, attempts: m.attempts + 1, due_at: now + ex.timeout_ms + LEASE_SLACK_MS, updated_at: now });
          out.push({
            moment: m.short_id,
            source: source.name,
            input: { kind: m.kind, subject: m.subject, at: m.event_at, refs: m.refs_json ? JSON.parse(m.refs_json) : {}, events: m.events, moment: m.short_id },
            extractor: { path: ex.path, root: ex.root, version: ex.version, timeout_ms: ex.timeout_ms },
            storage: m.storage ?? "host",
          });
        }
      }
    }
    return out;
  },
});

type Finishing = {
  moment: Doc<"moments">;
  source: Doc<"event_sources">;
  judges: Doc<"judges">[];
};

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
    const judges = (await ctx.db.query("judges").withIndex("by_source_kind", (q: any) => q.eq("source_id", moment.source_id).eq("moment_kind", moment.kind)).collect())
      .filter((j: Doc<"judges">) => !j.removed_at)
      .slice(0, JUDGES_PER_MOMENT);
    return { moment, source, judges };
  },
});

export const markFailed = internalMutation({
  args: { moment_id: v.id("moments"), error: v.string(), retry: v.boolean() },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.moment_id);
    if (!m) return;
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
    blocks: v.number(),
    body_bytes: v.number(),
    body_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.moment_id);
    if (!m) return;
    await ctx.db.patch(m._id, {
      status: "ready",
      extractor_version: args.extractor_version,
      extracted_at: args.extracted_at,
      gap_ms: Math.max(0, args.extracted_at - m.event_at),
      blocks: args.blocks,
      body_bytes: args.body_bytes,
      ...(args.body_key ? { body_key: args.body_key, body_expires_at: args.extracted_at + MOMENT_LIMITS.retention_ms } : {}),
      error: undefined,
      claim_device: undefined,
      updated_at: Date.now(),
    });
  },
});

/** Where a codecast-kept body lives in the replays bucket: under its source, content addressed. */
export function momentBodyKey(sourceId: string, shortId: string, sha: string): string {
  return `moments/${sourceId}/${shortId}-${sha}.json.gz`;
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
  handler: async (ctx, args): Promise<{ moment: string; status: "ready" | "failed" | "waiting"; storage?: string; judged?: JudgeOutcome[]; error?: string }> => {
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
    const record: MomentRecord = {
      ...parsed,
      kind: f.moment.kind,
      subject: f.moment.subject,
      event_at: f.moment.event_at,
      extracted_at: extractedAt,
      gap_ms: Math.max(0, extractedAt - f.moment.event_at),
      extractor: { path: `.codecast/moments/${f.moment.kind}.ts`, version: args.extractor_version },
    };
    const json = JSON.stringify(record);
    const storage = f.moment.storage ?? "host";
    let bodyKey: string | undefined;
    if (storage === "codecast") {
      const bucket = replaysBucketFromEnv();
      if (!bucket) {
        await ctx.runMutation(internal.moments.markFailed, { moment_id: f.moment._id, error: "moment storage is not configured (REPLAYS_R2_*)", retry: true });
        return { moment: args.moment, status: "waiting", error: "storage is not configured" };
      }
      bodyKey = momentBodyKey(String(f.moment.source_id), f.moment.short_id, await sha256Hex(json));
      await putChunk(bucket, bodyKey, gzipSync(strToU8(json)));
    }
    await ctx.runMutation(internal.moments.markReady, {
      moment_id: f.moment._id,
      extractor_version: args.extractor_version,
      extracted_at: extractedAt,
      blocks: record.blocks.length,
      body_bytes: json.length,
      ...(bodyKey ? { body_key: bodyKey } : {}),
    });
    const judged = await judgeMoment(ctx, f, record);
    return { moment: args.moment, status: "ready", storage, judged };
  },
});

// ── 4. Judging ──

export type JudgeOutcome = { judge: string; status: "ok" | "failed" | "skipped"; findings: number; filed: number; reason?: string; cost_usd: number };

/** The expectations each project is graded against, at its current version. */
export const briefsFor = internalQuery({
  args: { project_ids: v.array(v.id("projects")) },
  handler: async (ctx, args): Promise<Array<ExpectationsBrief & { project_id: Id<"projects"> }>> => {
    const out: Array<ExpectationsBrief & { project_id: Id<"projects"> }> = [];
    for (const id of args.project_ids) {
      const project = await ctx.db.get(id);
      if (!project) continue;
      const row = await ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => q.eq("project_id", id)).order("desc").first();
      if (!row) continue;
      const doc: ExpectationsVersion = { project: { id: String(id), title: project.title }, version: row.version, prefix: row.prefix, items: row.items, applied_at: row.created_at, how: row.how, summary: row.summary };
      out.push({
        project_id: id,
        project: project.title,
        version: row.version,
        text: renderExpectations(doc, { brief: true }),
        ids: row.items.filter((e: any) => e.status === "active").map((e: any) => e.id),
      });
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
    model: v.string(),
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

const refUrl = (m: MomentRecord) => m.refs.find((r) => r.url)?.url;

/**
 * Every judge of the moment's kind reads it (LL8), one call each inside the
 * team's budget. A shadow judge's findings stay on its run; a live judge's
 * also file, each into the project holding the expectation it cites, as the
 * person who set the source up (the way promoted signals file, X6).
 */
async function judgeMoment(ctx: any, f: Finishing, record: MomentRecord): Promise<JudgeOutcome[]> {
  const scope = { workspace: f.moment.workspace, ...(f.moment.team_id ? { team_id: f.moment.team_id } : {}) };
  const outcomes: JudgeOutcome[] = [];
  for (const judge of f.judges) {
    const briefs: Array<ExpectationsBrief & { project_id: Id<"projects"> }> = await ctx.runQuery(internal.moments.briefsFor, { project_ids: judge.project_ids });
    const expectations = briefs.map((b) => ({ project_id: b.project_id, version: b.version }));
    const base = { judge_id: judge._id, moment_id: f.moment._id, expectations, model: judge.model };
    const ids = briefs.flatMap((b) => b.ids);
    if (!ids.length) {
      const reason = "its projects have no expectations to grade against yet";
      await ctx.runMutation(internal.moments.recordRun, { ...base, status: "skipped", reason, findings: 0, cost_usd: 0 });
      outcomes.push({ judge: judge.name, status: "skipped", findings: 0, filed: 0, reason, cost_usd: 0 });
      continue;
    }
    const spec: JudgeSpec = { name: judge.name, moment: judge.moment_kind, model: judge.model, max_tokens: judge.max_tokens, projects: judge.projects, mode: judge.mode, prompt: judge.prompt };
    const result = await runModelCall(ctx, scope, "judge", judgeRequest(spec, briefs, record, Date.now()), `Judge ${judge.name}`);
    if (!result.ok) {
      const status = result.reason === "budget" ? "skipped" : "failed";
      await ctx.runMutation(internal.moments.recordRun, { ...base, status, reason: result.error, findings: 0, cost_usd: result.cost_usd });
      outcomes.push({ judge: judge.name, status, findings: 0, filed: 0, reason: result.error, cost_usd: result.cost_usd });
      continue;
    }
    const parsed = parseJudgeReply(result.text, ids);
    if (!parsed) {
      const reason = "the answer held no deviations list";
      await ctx.runMutation(internal.moments.recordRun, { ...base, status: "failed", reason, findings: 0, cost_usd: result.cost_usd });
      outcomes.push({ judge: judge.name, status: "failed", findings: 0, filed: 0, reason, cost_usd: result.cost_usd });
      continue;
    }
    const signalIds = judge.mode === "live" ? await fileFindings(ctx, f, judge, briefs, parsed.findings, record) : [];
    await ctx.runMutation(internal.moments.recordRun, {
      ...base,
      status: "ok",
      findings_json: JSON.stringify(parsed.findings),
      findings: parsed.findings.length,
      ...(parsed.uncited ? { uncited: parsed.uncited } : {}),
      ...(signalIds.length ? { signal_ids: signalIds } : {}),
      cost_usd: result.cost_usd,
    });
    outcomes.push({ judge: judge.name, status: "ok", findings: parsed.findings.length, filed: signalIds.length, cost_usd: result.cost_usd });
  }
  return outcomes;
}

async function fileFindings(ctx: any, f: Finishing, judge: Doc<"judges">, briefs: Array<ExpectationsBrief & { project_id: Id<"projects"> }>, findings: JudgeFinding[], record: MomentRecord): Promise<Id<"signals">[]> {
  const ids: Id<"signals">[] = [];
  for (const finding of findings) {
    const project = briefs.find((b) => b.ids.includes(finding.expectation))?.project_id;
    const signal = findingSignal(finding, { judge: judge.name, judge_version: judge.version, moment: f.moment.short_id }, refUrl(record));
    try {
      const filed = await ctx.runAction(internal.signals.ingestAs, {
        user_id: f.source.owner_user_id,
        ...signal,
        observed_at: record.at ?? record.event_at,
        ...(f.source.team_id ? { workspace: "team" as const, team_id: f.source.team_id } : { workspace: "personal" as const }),
        ...(project ? { project: String(project) } : {}),
      });
      ids.push(filed.signal_id);
    } catch (error) {
      console.error(`Judge ${judge.name} on ${f.moment.short_id}: filing a finding failed`, error);
    }
  }
  return ids;
}

// ── Reads ──

function momentView(m: Doc<"moments">) {
  return {
    short_id: m.short_id,
    kind: m.kind,
    subject: m.subject,
    status: m.status,
    events: m.events,
    event_at: m.event_at,
    ...(m.extracted_at ? { extracted_at: m.extracted_at, gap_ms: m.gap_ms } : {}),
    ...(m.extractor_version ? { extractor_version: m.extractor_version } : {}),
    storage: m.storage ?? "host",
    kept: !!m.body_key,
    ...(m.blocks !== undefined ? { blocks: m.blocks } : {}),
    ...(m.error ? { error: m.error } : {}),
    ...(m.judged_at ? { judged_at: m.judged_at } : {}),
    created_at: m.created_at,
  };
}

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
    for (const s of sources) {
      for (const e of await ctx.db.query("moment_extractors").withIndex("by_source_kind", (q: any) => q.eq("source_id", s._id)).collect()) {
        extractors.push({ source: s.name, kind: e.kind, version: e.version, quiet_ms: e.quiet_ms, published_at: e.published_at });
      }
      for (const j of await ctx.db.query("judges").withIndex("by_source_name", (q: any) => q.eq("source_id", s._id)).collect()) {
        if (!j.removed_at) judges.push({ source: s.name, name: j.name, version: j.version, moment: j.moment_kind, model: j.model, mode: j.mode, projects: j.projects });
      }
    }
    return { moments: moments.map(momentView), extractors, judges };
  },
});

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
      moment: { ...momentView(m), source: source?.name, refs: m.refs_json ? JSON.parse(m.refs_json) : {} },
      runs: runs.map((r: Doc<"judge_runs">) => ({
        judge: r.judge,
        judge_version: r.judge_version,
        mode: r.mode,
        status: r.status,
        ...(r.reason ? { reason: r.reason } : {}),
        findings: r.findings_json ? JSON.parse(r.findings_json) : [],
        ...(r.uncited ? { uncited: r.uncited } : {}),
        filed: r.signal_ids?.length ?? 0,
        expectations: r.expectations.map((e) => e.version),
        model: r.model,
        cost_usd: r.cost_usd,
        at: r.at,
      })),
    };
  },
});

export const bodyKeyFor = internalQuery({
  args: { ...scopeArgs, moment: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const { workspaceKey } = await scopeOf(ctx, args);
    const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment.trim())).first();
    if (!m || m.workspace !== workspaceKey) throw new Error(`No moment ${args.moment} in this workspace`);
    return m.body_key && (m.body_expires_at ?? 0) > Date.now() ? m.body_key : null;
  },
});

/** A codecast-kept moment's body, for `cast line moments show --body`. Null when the body is on the host or past 30 days. */
export const bodyForCli = action({
  args: { ...scopeArgs, moment: v.string() },
  handler: async (ctx, args): Promise<MomentRecord | null> => {
    const key: string | null = await ctx.runQuery(internal.moments.bodyKeyFor, args);
    const bucket = replaysBucketFromEnv();
    if (!key || !bucket) return null;
    const res = await fetch(await r2Presign(bucket, "GET", key, 300));
    if (!res.ok) return null;
    return JSON.parse(strFromU8(gunzipSync(new Uint8Array(await res.arrayBuffer()))));
  },
});

// ── Upkeep ──

/**
 * Daily: a kept body past 30 days is gone from R2 (the bucket's lifecycle
 * rule), so its row stops pointing at it; a moment no extractor ever took,
 * or one that failed, is dropped after 30 days. Judge runs stay.
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
