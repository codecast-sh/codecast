// Agent reviews (docs/architecture/learning-loop.md LL8): an agent judge's
// reading of a moment, run as a Claude Code session on a machine rather than
// one model call here.
//
// 1. Queue. Judging a moment (lib/momentJudging.judgeMoment) puts each agent
//    judge's review of it in agent_reviews, queued; nothing runs here. A
//    published judge queues only the moments judged after it, so publishing
//    one never reaches back over old moments: a person starts those
//    (`cast line reviews start`, which opens moments as of now).
// 2. Claim. A machine running reviews (`cast line reviews run`, the daemon's
//    pass) leases as many as it has free slots, each with the judge's session
//    spec and the prompt built from the moment's kept body, and renews the
//    lease while the session runs. A lease nobody renewed goes back to the
//    queue, three times at most.
// 3. Settle. The machine hands back the session's two turns: the review, and
//    its findings as JSON. The transcript goes to R2 beside the moment's
//    body; the findings are recorded on a judge_runs row (backend
//    subscription, charged no budget) and, for a live judge, filed as
//    signals into its project, where grouping places them (findingGroups.ts).

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { workspaceGrantsAccess } from "./lib/access";
import { nextShortId } from "./counters";
import { ownDevice } from "./devices";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf, sourceByRef, sourceFilingScope } from "./lib/ingestScope";
import { MOMENTS_30D_ROOT, MOMENTS_KEPT_ROOT, replaysBucketFromEnv } from "./lib/r2";
import { sha256Hex } from "./lib/hash";
import { liveBodyKey, readKeptBody, readKeptJson } from "./lib/momentBody";
import { putChunk } from "./replays";
import { retireSignals } from "./judgeRetire";
import { embedFinding } from "./findingGroups";
import { firstSentence } from "@codecast/shared/contracts/judges";
import { recordMomentEvents } from "./moments";
import { AGENT_FINDINGS_TURN, agentFindingSignal, agentJudgePrompt, agentRunFinding, agentSimilarText, parseAgentFindings, type AgentFinding, type ReviewTranscript } from "@codecast/shared/contracts/agentJudges";
import { MOMENT_KIND } from "@codecast/shared/contracts/moments";

/** A lease the machine has not renewed in this long goes back to the queue. */
const LEASE_MS = 10 * 60_000;
/** Tries a review gets before it fails for good: a lease that ran out, or a session that ended in an error. */
const REVIEW_TRIES = 3;
/** Reviews one claim may lease. */
const CLAIM_MAX = 32;
/** Subjects one bulk start may name per call. */
const START_BATCH = 500;

// ── 1. Queue ──

/** An agent judge's review of a moment, queued; one already open for the same moment and judge is reused. */
export const enqueue = internalMutation({
  args: { moment_id: v.id("moments"), judge_id: v.id("judges") },
  handler: async (ctx, args): Promise<{ review: string; status: string }> => {
    const moment = await ctx.db.get(args.moment_id);
    const judge = await ctx.db.get(args.judge_id);
    if (!moment || !judge) throw new Error("no such moment or judge");
    const open = (await ctx.db.query("agent_reviews").withIndex("by_moment", (q: any) => q.eq("moment_id", moment._id)).collect())
      .find((r: Doc<"agent_reviews">) => r.judge_id === judge._id && (r.status === "queued" || r.status === "running"));
    if (open) return { review: open.short_id, status: open.status };
    const now = Date.now();
    const short_id = await nextShortId(ctx.db, "rv");
    await ctx.db.insert("agent_reviews", {
      workspace: moment.workspace,
      ...(moment.team_id ? { team_id: moment.team_id } : {}),
      source_id: moment.source_id,
      judge_id: judge._id,
      judge: judge.name,
      judge_version: judge.version,
      moment_id: moment._id,
      moment_short_id: moment.short_id,
      subject: moment.subject,
      short_id,
      status: "queued",
      ...(moment.batch ? { batch: moment.batch } : {}),
      attempts: 0,
      created_at: now,
      updated_at: now,
    });
    return { review: short_id, status: "queued" };
  },
});

/**
 * `cast line reviews start`: open a moment of `kind` as of now (or `as_of`) for each
 * subject (a contact), the way the product's own event would, labelled with
 * the batch. The machine that runs the kind's extractor reads each, and
 * judging it queues each agent judge's review. A subject already waiting
 * joins its waiting moment.
 */
export const startForCli = mutation({
  args: { ...scopeArgs, source: v.string(), kind: v.string(), subjects: v.array(v.string()), batch: v.optional(v.string()), as_of: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = await sourceByRef(ctx, userId, workspaceKey, args.source);
    const kind = args.kind.trim().toLowerCase();
    if (!MOMENT_KIND.test(kind)) throw new Error(`"${args.kind}" is not a moment kind`);
    if (args.subjects.length > START_BATCH) throw new Error(`at most ${START_BATCH} subjects per call`);
    const ex = await ctx.db.query("moment_extractors").withIndex("by_source_kind", (q: any) => q.eq("source_id", source._id).eq("kind", kind)).first();
    if (!ex) throw new Error(`${source.name} has no published extractor for ${kind}`);
    const judges = (await ctx.db.query("judges").withIndex("by_source_kind", (q: any) => q.eq("source_id", source._id).eq("moment_kind", kind)).collect()).filter((j: Doc<"judges">) => !j.removed_at);
    if (!judges.some((j: Doc<"judges">) => j.agent)) throw new Error(`${source.name} has no agent judge reading ${kind}; the moments would be read and judged by its other judges only`);
    const now = Date.now();
    const subjects = [...new Set(args.subjects.map((s) => s.trim()).filter(Boolean))];
    // Due at once: a bulk start is not a burst of live events, so no quiet window is waited out.
    // as_of reads each as it stood then (the extractor's refs.as_of): a replay of a past time, to compare a review with an earlier one.
    const refs = args.as_of ? { as_of: new Date(args.as_of).toISOString() } : undefined;
    const opened = await recordMomentEvents(ctx, source, subjects.map((subject) => ({ type: "moment" as const, kind, subject, at: now, ...(refs ? { refs } : {}) })), now, { due_at: now, ...(args.batch ? { batch: args.batch } : {}) });
    return { source: source.name, kind, subjects: subjects.length, opened, joined: subjects.length - opened };
  },
});

// ── 2. Claim ──

/** The machine's lease on up to `n` queued reviews of judges its person published, oldest first; leases nobody renewed go back first. */
export const lease = internalMutation({
  args: { api_token: v.string(), device_id: v.string(), n: v.number() },
  handler: async (ctx, args): Promise<Array<{ review: Doc<"agent_reviews">; judge: Doc<"judges">; moment: Doc<"moments"> }>> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth || !(await ownDevice(ctx, auth.userId, args.device_id))) throw new Error("Unauthorized");
    const now = Date.now();
    const lapsed: Doc<"agent_reviews">[] = await ctx.db.query("agent_reviews").withIndex("by_status_created", (q: any) => q.eq("status", "running")).take(200);
    for (const r of lapsed) {
      if ((r.lease_until ?? 0) > now) continue;
      const again = r.attempts < REVIEW_TRIES;
      await ctx.db.patch(r._id, { status: again ? "queued" : "failed", error: `the machine running it (${r.claim_device ?? "unknown"}) stopped renewing its lease`, claim_device: undefined, lease_until: undefined, updated_at: now });
    }
    const n = Math.min(Math.max(0, Math.floor(args.n)), CLAIM_MAX);
    const out: Array<{ review: Doc<"agent_reviews">; judge: Doc<"judges">; moment: Doc<"moments"> }> = [];
    if (!n) return out;
    const judges = new Map<string, Doc<"judges"> | null>();
    const queued: Doc<"agent_reviews">[] = await ctx.db.query("agent_reviews").withIndex("by_status_created", (q: any) => q.eq("status", "queued")).take(n * 4);
    for (const r of queued) {
      if (out.length >= n) break;
      if (!judges.has(String(r.judge_id))) judges.set(String(r.judge_id), await ctx.db.get(r.judge_id));
      const judge = judges.get(String(r.judge_id));
      const moment = await ctx.db.get(r.moment_id);
      if (!judge || judge.removed_at || !judge.agent || !moment) {
        await ctx.db.patch(r._id, { status: "cancelled", error: !moment ? "its moment is gone" : "its judge was removed or is no longer an agent judge", updated_at: now });
        continue;
      }
      if (judge.publisher_user_id !== auth.userId) continue;
      const patch = { status: "running" as const, claim_device: args.device_id, attempts: r.attempts + 1, lease_until: now + LEASE_MS, started_at: now, error: undefined, updated_at: now };
      await ctx.db.patch(r._id, patch);
      out.push({ review: { ...r, ...patch }, judge, moment });
    }
    return out;
  },
});

export type ReviewClaim = {
  review: string;
  moment: string;
  subject: string;
  source: string;
  judge: { name: string; version: string; model: string; root: string; agent: NonNullable<Doc<"judges">["agent"]> };
  /** The two turns, in order: the judge's prompt with the moment in it, then the findings turn. */
  turns: [string, string];
  /** When the session must be stopped. */
  deadline: number;
};

/**
 * `/cli/reviews/claim`: up to `slots` reviews for this machine, each ready to
 * run: the judge's session spec, where its repo sits on the publishing
 * machine, and both turns. A review whose moment body is gone fails here.
 */
export const claimForCli = action({
  args: { api_token: v.string(), device_id: v.string(), slots: v.number() },
  handler: async (ctx, args): Promise<ReviewClaim[]> => {
    const leased: Array<{ review: Doc<"agent_reviews">; judge: Doc<"judges">; moment: Doc<"moments"> }> = await ctx.runMutation(internal.agentReviews.lease, { api_token: args.api_token, device_id: args.device_id, n: args.slots });
    const out: ReviewClaim[] = [];
    for (const { review, judge, moment } of leased) {
      const body = await readKeptBody(liveBodyKey(moment, Date.now()));
      if (!body) {
        await ctx.runMutation(internal.agentReviews.settle, { review_id: review._id, status: "failed", error: "its moment's body is not kept in codecast (an agent judge reads a moment its source stores in codecast)" });
        continue;
      }
      const source = await ctx.runQuery(internal.agentReviews.sourceName, { source_id: review.source_id });
      const root = await ctx.runQuery(internal.agentReviews.judgeRoot, { source_id: review.source_id, kind: moment.kind });
      out.push({
        review: review.short_id,
        moment: moment.short_id,
        subject: moment.subject,
        source,
        judge: { name: judge.name, version: judge.version, model: judge.model, root, agent: judge.agent! },
        turns: [agentJudgePrompt(judge.prompt, body, moment.who ?? null), AGENT_FINDINGS_TURN],
        deadline: Date.now() + judge.agent!.timeout_ms,
      });
    }
    return out;
  },
});

export const sourceName = internalQuery({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args): Promise<string> => (await ctx.db.get(args.source_id))?.name ?? "",
});

/** The checkout the judge was published from: its extractor's root, on the publishing machine. */
export const judgeRoot = internalQuery({
  args: { source_id: v.id("event_sources"), kind: v.string() },
  handler: async (ctx, args): Promise<string> => (await ctx.db.query("moment_extractors").withIndex("by_source_kind", (q: any) => q.eq("source_id", args.source_id).eq("kind", args.kind)).first())?.root ?? "",
});

/** `/cli/reviews/renew`: the machine is still running these; their leases move out. Returns the ones no longer its own (cancelled, or taken back), which it stops. */
export const renewForCli = mutation({
  args: { api_token: v.string(), device_id: v.string(), reviews: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ lost: string[] }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth || !(await ownDevice(ctx, auth.userId, args.device_id))) throw new Error("Unauthorized");
    const now = Date.now();
    const lost: string[] = [];
    for (const ref of args.reviews.slice(0, 100)) {
      const r = await ctx.db.query("agent_reviews").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
      if (!r || r.status !== "running" || r.claim_device !== args.device_id) { lost.push(ref); continue; }
      // Written only once half the lease is spent: a renewal every pass would rewrite every running row twice a minute.
      if ((r.lease_until ?? 0) - now < LEASE_MS / 2) await ctx.db.patch(r._id, { lease_until: now + LEASE_MS, updated_at: now });
    }
    return { lost };
  },
});

// ── 3. Settle ──

const usageArg = v.object({ input: v.number(), output: v.number(), cache_read: v.number(), cache_write: v.number() });

/** The review as its machine hands it back, checked: still running there. */
export const handing = internalQuery({
  args: { api_token: v.string(), device_id: v.string(), review: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const review = await ctx.db.query("agent_reviews").withIndex("by_short_id", (q: any) => q.eq("short_id", args.review)).first();
    if (!review || review.status !== "running" || review.claim_device !== args.device_id) throw new Error(`${args.review} is not running on this machine`);
    const judge = (await ctx.db.get(review.judge_id))!;
    const moment = (await ctx.db.get(review.moment_id))!;
    const source = (await ctx.db.get(review.source_id))!;
    return { review, judge, moment, source };
  },
});

/**
 * `/cli/reviews/done`: a review's session handed back. A failed session goes
 * back to the queue while it has tries left (`retry`, for a session cut off by
 * a usage limit, does not spend one). A finished one keeps its transcript,
 * records its findings as the judge's run and, for a live judge, files them.
 */
export const doneForCli = action({
  args: {
    api_token: v.string(),
    device_id: v.string(),
    review: v.string(),
    ok: v.boolean(),
    error: v.optional(v.string()),
    /** The session stopped for a reason that is not the review's (a usage limit): it queues again without spending a try. */
    retry: v.optional(v.boolean()),
    /** The second turn's answer: the findings JSON. */
    findings_text: v.optional(v.string()),
    /** The whole session (ReviewTranscript), gzipped and base64. */
    transcript_gz: v.optional(v.string()),
    account: v.optional(v.string()),
    took_ms: v.optional(v.number()),
    turns: v.optional(v.number()),
    usage: v.optional(usageArg),
    notional_usd: v.optional(v.number()),
    findings_turn_usd: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ review: string; status: string; findings?: number; filed?: number; error?: string }> => {
    const h: { review: Doc<"agent_reviews">; judge: Doc<"judges">; moment: Doc<"moments">; source: Doc<"event_sources"> } = await ctx.runQuery(internal.agentReviews.handing, { api_token: args.api_token, device_id: args.device_id, review: args.review });
    const spent = { ...(args.account ? { account: args.account } : {}), ...(args.took_ms !== undefined ? { took_ms: args.took_ms } : {}), ...(args.turns !== undefined ? { turns: args.turns } : {}), ...(args.usage ? { usage: args.usage } : {}), ...(args.notional_usd !== undefined ? { notional_usd: args.notional_usd } : {}), ...(args.findings_turn_usd !== undefined ? { findings_turn_usd: args.findings_turn_usd } : {}) };
    let transcriptKey: string | undefined;
    let transcriptBytes: number | undefined;
    if (args.transcript_gz) {
      const bucket = replaysBucketFromEnv();
      if (bucket) {
        const bytes = Uint8Array.from(atob(args.transcript_gz), (c) => c.charCodeAt(0));
        const keep = h.source.config?.moment_retention === "keep";
        transcriptKey = `${keep ? MOMENTS_KEPT_ROOT : MOMENTS_30D_ROOT}${h.review.source_id}/reviews/${h.review.short_id}-${(await sha256Hex(args.transcript_gz)).slice(0, 16)}.json.gz`;
        await putChunk(bucket, transcriptKey, bytes);
        transcriptBytes = bytes.length;
      }
    }
    const kept = { ...(transcriptKey ? { transcript_key: transcriptKey, transcript_bytes: transcriptBytes } : {}) };
    const findings = args.ok ? parseAgentFindings(args.findings_text ?? "") : null;
    const gate = { review_id: h.review._id, device_id: args.device_id };
    if (!args.ok || !findings) {
      const error = (args.ok ? "the findings turn held no findings list" : args.error || "the session ended without an answer").slice(0, 500);
      const again = args.retry || h.review.attempts < REVIEW_TRIES;
      if (!(await ctx.runMutation(internal.agentReviews.settle, { ...gate, status: again ? "queued" : "failed", error, ...(args.retry ? { refund: true } : {}), ...spent, ...kept }))) return { review: args.review, status: "settled", error: "already handed back" };
      if (!again) await ctx.runMutation(internal.moments.recordRun, { judge_id: h.judge._id, moment_id: h.moment._id, status: "failed", reason: error, expectations: [], findings: 0, model: h.judge.model, backend: "subscription", cost_usd: 0 });
      return { review: args.review, status: again ? "queued" : "failed", error };
    }
    // Accepted in one step with its filing scheduled, so the hand back returns at once and a repeat of it (a timed out
    // request sent again) finds the review settled and files nothing twice.
    if (!(await ctx.runMutation(internal.agentReviews.settle, { ...gate, status: "done", findings: findings.length, file: JSON.stringify(findings), ...spent, ...kept }))) return { review: args.review, status: "settled", error: "already handed back" };
    return { review: args.review, status: "done", findings: findings.length };
  },
});

/**
 * A settled review's findings recorded as its judge's run and, for a live
 * judge, filed one by one through the door, so a finding can group with one
 * filed just before it. What an earlier review of the same moment filed and
 * this one did not file again is replaced.
 */
export const fileReview = internalAction({
  args: { review_id: v.id("agent_reviews"), findings: v.string() },
  handler: async (ctx, args) => {
    const h: { review: Doc<"agent_reviews">; judge: Doc<"judges">; moment: Doc<"moments">; source: Doc<"event_sources">; earlier: Id<"signals">[] } | null = await ctx.runQuery(internal.agentReviews.filing, { review_id: args.review_id });
    if (!h) return;
    const findings: AgentFinding[] = JSON.parse(args.findings);
    const signalIds: Id<"signals">[] = [];
    if (h.judge.mode === "live") {
      const body = await readKeptBody(liveBodyKey(h.moment, Date.now()));
      const evidenceUrl = body?.refs.find((r) => r.url)?.url;
      const project = h.judge.project_ids[0];
      for (const f of findings) {
        try {
          const signal = agentFindingSignal(f, { judge: h.judge.name, judge_version: h.judge.version, moment: h.moment.short_id, subject: h.moment.subject }, evidenceUrl);
          const result = await ctx.runAction(internal.signals.ingestAs, { user_id: h.source.owner_user_id, ...signal, observed_at: h.moment.extracted_at ?? h.moment.event_at, ...sourceFilingScope(h.source), ...(project ? { project: String(project) } : {}) });
          signalIds.push(result.signal_id);
        } catch (error) {
          console.error(`Agent review ${h.review.short_id}: filing a finding failed`, error);
        }
      }
      const kept = new Set(signalIds.map(String));
      const replaced = h.earlier.filter((id) => !kept.has(String(id)));
      if (replaced.length) await ctx.runMutation(internal.agentReviews.retireReplaced, { signal_ids: replaced, review: h.review.short_id, judge_version: h.judge.version, actor: h.source.owner_user_id });
    }
    const runId = await ctx.runMutation(internal.moments.recordRun, {
      judge_id: h.judge._id,
      moment_id: h.moment._id,
      status: "ok",
      expectations: [],
      findings_json: JSON.stringify(findings.map((f) => agentRunFinding(f, h.judge.name))),
      findings: findings.length,
      ...(signalIds.length ? { signal_ids: signalIds } : {}),
      model: h.judge.model,
      backend: "subscription",
      cost_usd: 0,
    });
    await ctx.runMutation(internal.agentReviews.filed, { review_id: args.review_id, filed: signalIds.length, ...(runId ? { run_id: runId } : {}) });
  },
});

export const filing = internalQuery({
  args: { review_id: v.id("agent_reviews") },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.review_id);
    if (!review || review.status !== "done" || review.run_id) return null;
    const judge = (await ctx.db.get(review.judge_id))!;
    const moment = (await ctx.db.get(review.moment_id))!;
    const source = (await ctx.db.get(review.source_id))!;
    const earlier: Doc<"judge_runs">[] = (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", moment._id)).collect()).filter((r: Doc<"judge_runs">) => r.judge_id === judge._id);
    return { review, judge, moment, source, earlier: earlier.flatMap((r) => r.signal_ids ?? []) };
  },
});

export const filed = internalMutation({
  args: { review_id: v.id("agent_reviews"), filed: v.number(), run_id: v.optional(v.id("judge_runs")) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.review_id, { filed: args.filed, ...(args.run_id ? { run_id: args.run_id } : {}), updated_at: Date.now() });
  },
});

/**
 * A review's outcome, written only while it is still running on the machine
 * handing it back (false otherwise: another hand back of it settled it
 * first). A done review with findings schedules their filing in the same step.
 */
export const settle = internalMutation({
  args: {
    review_id: v.id("agent_reviews"),
    device_id: v.optional(v.string()),
    status: v.union(v.literal("queued"), v.literal("done"), v.literal("failed")),
    error: v.optional(v.string()),
    refund: v.optional(v.boolean()),
    findings: v.optional(v.number()),
    /** The findings as JSON, to file once settled (fileReview). */
    file: v.optional(v.string()),
    transcript_key: v.optional(v.string()),
    transcript_bytes: v.optional(v.number()),
    account: v.optional(v.string()),
    took_ms: v.optional(v.number()),
    turns: v.optional(v.number()),
    usage: v.optional(usageArg),
    notional_usd: v.optional(v.number()),
    findings_turn_usd: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const r = await ctx.db.get(args.review_id);
    if (!r || r.status !== "running" || (args.device_id && r.claim_device !== args.device_id)) return false;
    const now = Date.now();
    const { review_id, device_id: _d, refund, status, file, ...rest } = args;
    await ctx.db.patch(r._id, {
      ...rest,
      status,
      ...(refund ? { attempts: Math.max(0, r.attempts - 1) } : {}),
      ...(status === "queued" ? { claim_device: undefined, lease_until: undefined } : { finished_at: now, lease_until: undefined }),
      ...(status === "done" ? { error: undefined } : {}),
      updated_at: now,
    });
    if (status === "done" && file) await ctx.scheduler.runAfter(0, internal.agentReviews.fileReview, { review_id, findings: file });
    return true;
  },
});

/** What an earlier review of the same moment filed and this one did not file again: replaced, so it leaves its problems. */
export const retireReplaced = internalMutation({
  args: { signal_ids: v.array(v.id("signals")), review: v.string(), judge_version: v.string(), actor: v.id("users") },
  handler: async (ctx, args) => {
    const rows = (await Promise.all(args.signal_ids.map((id) => ctx.db.get(id)))).filter((r): r is Doc<"signals"> => !!r && !r.retired && !r.merged_into);
    if (rows.length) await retireSignals(ctx, rows, { reason: `replaced by ${args.review}, a newer review of the same moment`, judge_version: args.judge_version, actor: args.actor });
  },
});

// ── Reads and controls ──

/** `cast line reviews status`: the queue's counts, what runs where, and what the newest finished reviews took. */
export const statusForCli = query({
  args: { ...scopeArgs, source: v.optional(v.string()), batch: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const sources: Doc<"event_sources">[] = args.source ? [await sourceByRef(ctx, userId, workspaceKey, args.source)] : await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspaceKey)).collect();
    const counts: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    const running: Doc<"agent_reviews">[] = [];
    const finished: Doc<"agent_reviews">[] = [];
    const failed: Doc<"agent_reviews">[] = [];
    for (const s of sources) {
      for (const status of ["queued", "running", "done", "failed", "cancelled"] as const) {
        const rows: Doc<"agent_reviews">[] = await ctx.db.query("agent_reviews").withIndex("by_source_status", (q: any) => q.eq("source_id", s._id).eq("status", status)).collect();
        const mine = args.batch ? rows.filter((r) => r.batch === args.batch) : rows;
        counts[status]! += mine.length;
        if (status === "running") running.push(...mine);
        if (status === "done") finished.push(...mine);
        if (status === "failed") failed.push(...mine);
      }
    }
    // A bulk start's moments by state: each is read by the extractor before its review can queue.
    const moments: Record<string, number> = { waiting: 0, extracting: 0, ready: 0, failed: 0 };
    if (args.batch) {
      for (const src of sources) {
        for (const status of ["waiting", "extracting", "ready", "failed"] as const) {
          const rows: Doc<"moments">[] = await ctx.db.query("moments").withIndex("by_source_kind_status_due", (q: any) => q.eq("source_id", src._id).eq("kind", "contact-conversation").eq("status", status)).collect();
          moments[status]! += rows.filter((m) => m.batch === args.batch).length;
        }
      }
    }
    const recent = finished.sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0)).slice(0, 200);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const hour = Date.now() - 60 * 60_000;
    return {
      counts,
      ...(args.batch ? { moments } : {}),
      running: running.map((r) => ({ review: r.short_id, moment: r.moment_short_id, subject: r.subject, device: r.claim_device, account: r.account, started_at: r.started_at, attempts: r.attempts })),
      recent: recent.slice(0, 20).map((r) => ({ review: r.short_id, moment: r.moment_short_id, subject: r.subject, findings: r.findings ?? 0, filed: r.filed ?? 0, took_ms: r.took_ms, turns: r.turns, notional_usd: r.notional_usd, account: r.account, finished_at: r.finished_at })),
      failed: failed.sort((a, b) => b.updated_at - a.updated_at).slice(0, 20).map((r) => ({ review: r.short_id, moment: r.moment_short_id, subject: r.subject, error: r.error, attempts: r.attempts })),
      averages: {
        of: recent.length,
        took_ms: mean(recent.flatMap((r) => (r.took_ms ? [r.took_ms] : []))),
        turns: mean(recent.flatMap((r) => (r.turns ? [r.turns] : []))),
        notional_usd: mean(recent.flatMap((r) => (r.notional_usd !== undefined ? [r.notional_usd] : []))),
        findings: mean(recent.map((r) => r.findings ?? 0)),
        last_hour: finished.filter((r) => (r.finished_at ?? 0) > hour).length,
      },
    };
  },
});

/** `cast line reviews cancel`: queued reviews (of a batch, or all of a source) stop waiting. Running ones finish. One page per call; `left` says whether to call again. */
export const cancelForCli = mutation({
  args: { ...scopeArgs, source: v.string(), batch: v.optional(v.string()), failed: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = await sourceByRef(ctx, userId, workspaceKey, args.source);
    const rows: Doc<"agent_reviews">[] = await ctx.db.query("agent_reviews").withIndex("by_source_status", (q: any) => q.eq("source_id", source._id).eq("status", "queued")).take(1000);
    const now = Date.now();
    let cancelled = 0;
    for (const r of rows) {
      if (args.batch && r.batch !== args.batch) continue;
      await ctx.db.patch(r._id, { status: "cancelled", error: "cancelled by a person", updated_at: now });
      cancelled++;
    }
    return { cancelled, left: rows.length === 1000 };
  },
});

/** `cast line reviews retry`: failed or cancelled reviews (of a batch, or all of a source) queue again with fresh tries. */
export const retryForCli = mutation({
  args: { ...scopeArgs, source: v.string(), batch: v.optional(v.string()), cancelled: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = await sourceByRef(ctx, userId, workspaceKey, args.source);
    const status = args.cancelled ? "cancelled" : "failed";
    const rows: Doc<"agent_reviews">[] = await ctx.db.query("agent_reviews").withIndex("by_source_status", (q: any) => q.eq("source_id", source._id).eq("status", status)).take(1000);
    const now = Date.now();
    let queued = 0;
    for (const r of rows) {
      if (args.batch && r.batch !== args.batch) continue;
      await ctx.db.patch(r._id, { status: "queued", attempts: 0, error: undefined, updated_at: now });
      queued++;
    }
    return { queued, left: rows.length === 1000 };
  },
});

/** One review's whole session, for a person to read (the Line page's run, `cast line reviews show`). */
export const transcriptForCli = action({
  args: { ...scopeArgs, review: v.string() },
  handler: async (ctx, args): Promise<{ review: Doc<"agent_reviews">; transcript: ReviewTranscript | null }> => {
    const review = await ctx.runQuery(internal.agentReviews.reviewIn, args);
    return { review, transcript: review.transcript_key ? await readKeptJson<ReviewTranscript>(review.transcript_key) : null };
  },
});

/** One review's whole session for the Line page: readable to whoever may read its moment (lineMoments.ts reads moments so). */
export const webTranscript = action({
  args: { review: v.string() },
  handler: async (ctx, args): Promise<{ review: string; transcript: ReviewTranscript | null }> => {
    const key: string | null = await ctx.runQuery(internal.agentReviews.webTranscriptKey, args);
    return { review: args.review, transcript: key ? await readKeptJson<ReviewTranscript>(key) : null };
  },
});

export const webTranscriptKey = internalQuery({
  args: { review: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const userId = await getAuthUserId(ctx);
    const review = await ctx.db.query("agent_reviews").withIndex("by_short_id", (q: any) => q.eq("short_id", args.review)).first();
    if (!userId || !review || !(await workspaceGrantsAccess(ctx, userId, review.workspace))) throw new Error("Not found");
    return review.transcript_key ?? null;
  },
});

export const reviewIn = internalQuery({
  args: { ...scopeArgs, review: v.string() },
  handler: async (ctx, args): Promise<Doc<"agent_reviews">> => {
    const { workspaceKey } = await scopeOf(ctx, args);
    const ref = args.review.trim();
    const byShort = await ctx.db.query("agent_reviews").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
    // A moment's newest review answers for the moment.
    const review = byShort ?? (await (async () => {
      const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
      if (!m) return null;
      const rows: Doc<"agent_reviews">[] = await ctx.db.query("agent_reviews").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect();
      return rows.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
    })());
    if (!review || review.workspace !== workspaceKey) throw new Error(`No review ${ref} in this workspace`);
    return review;
  },
});

/**
 * Findings an agent judge filed while no line profile let its source open
 * problems (signals.opensCause) sit held. Once a profile declares the finder,
 * this files each again through the door, where grouping places it, and
 * retires the held copy; the run that filed it points at the new one. One page
 * per call (run with packages/convex/run.sh); `left` says whether to call again.
 */
export const refileHeld = internalAction({
  // unembedded: the live findings that were filed with no words to group by (no kept embedding), which grouping never placed.
  args: { workspace: v.string(), judge: v.string(), limit: v.optional(v.number()), unembedded: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ refiled: number; left: boolean; tasks: string[] }> => {
    const page: Array<Doc<"signals">> = await ctx.runQuery(internal.agentReviews.heldFindings, { workspace: args.workspace, judge: args.judge, limit: Math.min(args.limit ?? 25, 100), ...(args.unembedded ? { unembedded: true } : {}) });
    const tasks = new Set<string>();
    for (const row of page) {
      const source = await ctx.runQuery(internal.agentReviews.sourceOfMoment, { moment: row.moment ?? "" });
      if (!source) continue;
      await ctx.runMutation(internal.agentReviews.retireHeld, { signal_id: row._id, judge: args.judge, actor: source.owner_user_id, ...(args.unembedded ? { reason: "filed again with the words grouping compares, which its first filing lacked" } : {}) });
      const result = await ctx.runAction(internal.signals.ingestAs, {
        user_id: source.owner_user_id,
        source: row.source, kind: row.kind, fingerprint: row.fingerprint, title: row.title, subject: row.subject,
        ...(row.detail_md ? { detail_md: row.detail_md } : {}), ...(row.evidence_url ? { evidence_url: row.evidence_url } : {}),
        ...(row.judge ? { judge: row.judge } : {}), ...(row.judge_version ? { judge_version: row.judge_version } : {}),
        ...(typeof row.severity === "number" ? { severity: row.severity } : {}), ...(row.moment ? { moment: row.moment } : {}),
        // The words grouping compares are not kept on a signal: rebuilt from the run's finding of the same key.
        ...(await (async () => {
          const found: { subject: string; findings: AgentFinding[] } = await ctx.runQuery(internal.agentReviews.runFindings, { moment: row.moment ?? "", judge: args.judge });
          const f = found.findings.find((x) => agentFindingSignal(x, { judge: args.judge, judge_version: row.judge_version ?? "", moment: row.moment ?? "", subject: found.subject }).fingerprint === row.fingerprint);
          return f ? { similar_text: agentSimilarText(f) } : {};
        })()),
        observed_at: row.observed_at,
        ...sourceFilingScope(source),
        ...(row.project_id ? { project: String(row.project_id) } : {}),
      });
      await ctx.runMutation(internal.agentReviews.repointRun, { old: row._id, signal_id: result.signal_id, moment: row.moment ?? "" });
      if (result.task_short_id) tasks.add(result.task_short_id);
    }
    return { refiled: page.length, left: page.length === Math.min(args.limit ?? 25, 100), tasks: [...tasks] };
  },
});

/** The findings an agent judge's newest run on a moment recorded, and the moment's subject. */
export const runFindings = internalQuery({
  args: { moment: v.string(), judge: v.string() },
  handler: async (ctx, args): Promise<{ subject: string; findings: AgentFinding[] }> => {
    const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment)).first();
    const runs: Doc<"judge_runs">[] = m ? (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect()).filter((r: Doc<"judge_runs">) => r.judge === args.judge && r.status === "ok") : [];
    const findings: AgentFinding[] = runs.flatMap((r) => { try { return JSON.parse(r.findings_json ?? "[]"); } catch { return []; } });
    return { subject: m?.subject ?? "", findings };
  },
});

export const heldFindings = internalQuery({
  args: { workspace: v.string(), judge: v.string(), limit: v.number(), unembedded: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Doc<"signals">[]> => {
    const rows: Doc<"signals">[] = (await ctx.db.query("signals").withIndex("by_workspace_subject", (q: any) => q.eq("workspace", args.workspace).eq("subject", args.judge)).collect())
      .filter((r: Doc<"signals">) => r.source === `judge:${args.judge}` && !r.retired && !r.merged_into);
    const out: Doc<"signals">[] = [];
    for (const r of rows) {
      if (out.length >= args.limit) break;
      if (!args.unembedded ? !r.task_id : !(await ctx.db.query("signal_vectors").withIndex("by_signal", (q: any) => q.eq("signal_id", r._id)).first())) out.push(r);
    }
    return out;
  },
});

export const sourceOfMoment = internalQuery({
  args: { moment: v.string() },
  handler: async (ctx, args): Promise<Doc<"event_sources"> | null> => {
    const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment)).first();
    return m ? await ctx.db.get(m.source_id) : null;
  },
});

export const retireHeld = internalMutation({
  args: { signal_id: v.id("signals"), judge: v.string(), actor: v.id("users"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.signal_id);
    if (row && !row.retired) await retireSignals(ctx, [row], { reason: args.reason ?? `filed again once judge:${args.judge} could open problems`, actor: args.actor });
  },
});

export const repointRun = internalMutation({
  args: { old: v.id("signals"), signal_id: v.id("signals"), moment: v.string() },
  handler: async (ctx, args) => {
    const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment)).first();
    if (!m) return;
    for (const r of await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect()) {
      if (r.signal_ids?.some((id) => id === args.old)) await ctx.db.patch(r._id, { signal_ids: r.signal_ids.map((id) => (id === args.old ? args.signal_id : id)) });
    }
  },
});

/**
 * Findings of one agent judge filed twice under one key (a hand back sent
 * again while the first was still filing, before settle became the one gate):
 * the first stands, the rest retire, and each run points at the one standing.
 */
export const retireDoubles = internalMutation({
  args: { workspace: v.string(), judge: v.string() },
  handler: async (ctx, args) => {
    const rows: Doc<"signals">[] = (await ctx.db.query("signals").withIndex("by_workspace_subject", (q: any) => q.eq("workspace", args.workspace).eq("subject", args.judge)).collect())
      .filter((r: Doc<"signals">) => r.source === `judge:${args.judge}` && !r.retired && !r.merged_into);
    const byKey = new Map<string, Doc<"signals">[]>();
    for (const r of rows) byKey.set(r.fingerprint, [...(byKey.get(r.fingerprint) ?? []), r]);
    const extra = [...byKey.values()].flatMap((rs) => rs.sort((a, b) => a.created_at - b.created_at).slice(1).map((r) => ({ r, keep: rs[0]! })));
    if (!extra.length) return { retired: 0 };
    const source = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", args.workspace)).first();
    await retireSignals(ctx, extra.map((x) => x.r), { reason: "filed twice under one key; the first stands", actor: source!.owner_user_id });
    for (const { r, keep } of extra) {
      const m = r.moment ? await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", r.moment)).first() : null;
      for (const run of m ? await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect() : []) {
        if (run.signal_ids?.includes(r._id)) await ctx.db.patch(run._id, { signal_ids: [...new Set(run.signal_ids.map((id) => (id === r._id ? keep._id : id)))] });
      }
    }
    return { retired: extra.length };
  },
});

/**
 * What text an agent finding should be grouped by, measured (run with
 * packages/convex/run.sh): every live finding of the judge embedded once per
 * variant of its words, and for each pair a person judged the same problem,
 * where the partner ranks among the finding's nearest and at what cosine.
 * The embeddings are charged to the team's grouping budget.
 */
export const groupingProbe = internalAction({
  args: { workspace: v.string(), judge: v.string(), pairs: v.array(v.array(v.string())) },
  handler: async (ctx, args) => {
    const rows: Doc<"signals">[] = await ctx.runQuery(internal.agentReviews.liveFindings, { workspace: args.workspace, judge: args.judge });
    const byMoment = new Map<string, { subject: string; findings: AgentFinding[] }>();
    const items: Array<{ id: string; f: AgentFinding }> = [];
    for (const r of rows) {
      if (!r.moment) continue;
      if (!byMoment.has(r.moment)) byMoment.set(r.moment, await ctx.runQuery(internal.agentReviews.runFindings, { moment: r.moment, judge: args.judge }));
      const found = byMoment.get(r.moment)!;
      const f = found.findings.find((x) => agentFindingSignal(x, { judge: args.judge, judge_version: "", moment: r.moment!, subject: found.subject }).fingerprint === r.fingerprint);
      if (f) items.push({ id: r.short_id, f });
    }
    const variants: Record<string, (f: AgentFinding) => string> = {
      cause_first: agentSimilarText,
      problem: (f) => firstSentence(f.what),
      problem_then_cause: (f) => (f.cause ? `${firstSentence(f.what)}\n${f.cause}` : firstSentence(f.what)),
    };
    const scope = { workspace: args.workspace };
    const out: Record<string, unknown> = { findings: items.length };
    for (const [name, text] of Object.entries(variants)) {
      const vecs = new Map<string, number[]>();
      // One at a time: each settles the team's budget row, and side by side they conflict on it.
      for (const it of items) {
        const e = await embedFinding(ctx, scope, text(it.f));
        if (e) vecs.set(it.id, e.vector);
      }
      const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0) / Math.sqrt(a.reduce((s, x) => s + x * x, 0) * b.reduce((s, x) => s + x * x, 0));
      const pairs = args.pairs.flatMap(([a, b]) => {
        const va = vecs.get(a!), vb = vecs.get(b!);
        if (!va || !vb) return [];
        const ranked = [...vecs.entries()].filter(([id]) => id !== a).map(([id, v]) => ({ id, c: cos(va, v) })).sort((x, y) => y.c - x.c);
        return [{ a, b, cos: Math.round(cos(va, vb) * 1000) / 1000, rank: ranked.findIndex((x) => x.id === b) + 1 }];
      });
      // How far apart findings of different problems sit: the mean of every finding's nearest other finding outside its pairs.
      out[name] = { pairs, mean_rank: pairs.reduce((s, p) => s + p.rank, 0) / Math.max(1, pairs.length), top5: pairs.filter((p) => p.rank <= 5).length, of: pairs.length };
    }
    return out;
  },
});

export const liveFindings = internalQuery({
  args: { workspace: v.string(), judge: v.string() },
  handler: async (ctx, args): Promise<Doc<"signals">[]> =>
    (await ctx.db.query("signals").withIndex("by_workspace_subject", (q: any) => q.eq("workspace", args.workspace).eq("subject", args.judge)).collect())
      .filter((r: Doc<"signals">) => r.source === `judge:${args.judge}` && !r.retired && !r.merged_into),
});

/**
 * Costs handed back before the machine read a resumed turn's cost as the
 * session's total so far (it reports the first turn's cost again): such a
 * review's notional_usd counted the first turn twice. With the findings
 * turn's figure (then that cumulative total) the session's cost is exactly
 * it; without, half the sum, short by half the findings turn (about 5 cents).
 * One page per call (run with packages/convex/run.sh).
 */
export const correctDoubledCosts = internalMutation({
  args: { before: v.number(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("agent_reviews").withIndex("by_status_created", (q: any) => q.eq("status", "done")).paginate({ cursor: args.cursor ?? null, numItems: 300 });
    let fixed = 0;
    for (const r of page.page as Doc<"agent_reviews">[]) {
      if (r.notional_usd == null || (r.finished_at ?? 0) >= args.before || r.cost_corrected) continue;
      const total = r.findings_turn_usd != null ? r.findings_turn_usd : r.notional_usd / 2;
      const turn = r.findings_turn_usd != null ? Math.max(0, 2 * r.findings_turn_usd - r.notional_usd) : undefined;
      await ctx.db.patch(r._id, { notional_usd: Math.round(total * 10_000) / 10_000, ...(turn !== undefined ? { findings_turn_usd: Math.round(turn * 10_000) / 10_000 } : {}), cost_corrected: true });
      fixed++;
    }
    return { fixed, cursor: page.isDone ? null : page.continueCursor };
  },
});

/** An agent judge's filing so far, counted page by page (run with packages/convex/run.sh): live findings, the problems they sit in, held ones, keys filed twice. */
export const filingCounts = internalAction({
  args: { workspace: v.string(), judge: v.string() },
  handler: async (ctx, args) => {
    const tasks = new Set<string>();
    const keys = new Map<string, number>();
    let live = 0, held = 0, retired = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: { rows: Array<{ task: string | null; key: string; retired: boolean }>; cursor: string | null } = await ctx.runQuery(internal.agentReviews.filingPage, { workspace: args.workspace, judge: args.judge, cursor });
      for (const r of page.rows) {
        if (r.retired) { retired++; continue; }
        live++;
        if (r.task) tasks.add(r.task); else held++;
        keys.set(r.key, (keys.get(r.key) ?? 0) + 1);
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    return { live, problems: tasks.size, held, retired, doubled: [...keys.values()].filter((n) => n > 1).length };
  },
});

export const filingPage = internalQuery({
  args: { workspace: v.string(), judge: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("signals").withIndex("by_workspace_subject", (q: any) => q.eq("workspace", args.workspace).eq("subject", args.judge)).paginate({ cursor: args.cursor, numItems: 400 });
    const rows = (page.page as Doc<"signals">[]).filter((r) => r.source === `judge:${args.judge}`).map((r) => ({ task: r.task_id ? String(r.task_id) : null, key: r.fingerprint, retired: !!r.retired || !!r.merged_into }));
    return { rows, cursor: page.isDone ? null : page.continueCursor };
  },
});
