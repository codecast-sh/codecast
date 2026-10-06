import type { ResourceOffloadIntent, ResourceOffloadBatchId } from "@codecast/shared/contracts/resourceOffloadIntent";
import { resourceOffloadSelection } from "./resourceOffloadSchema";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation } from "./functions";
import { RESOURCE_STALE_MS, evaluateOffloadRequirements } from "@codecast/shared/contracts";
import { performCreateBatch, planMigration } from "./sessionMigrations";

export const start = mutation({
  args: {
    source_device_id: v.string(),
    selections: v.array(resourceOffloadSelection),
    wait_for_idle_ms: v.number(),
    dry_run: v.optional(v.boolean()),
    client_batch_id: v.optional(v.string()),
    batch_ids: v.optional(v.array(v.object({ destination_id: v.string(), batch_id: v.string() }))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required");
    if (!args.selections.length || args.selections.length > 50) throw new Error("Select between 1 and 50 sessions");
    if (!Number.isFinite(args.wait_for_idle_ms) || args.wait_for_idle_ms < 60_000) throw new Error("Allow at least a minute to reach a safe turn boundary");
    if (new Set(args.selections.map(s => s.session_id)).size !== args.selections.length) throw new Error("A session may only be selected once");
    if (args.selections.some(s => s.attested.length > 20 || s.attested.some(a => a.length > 500))) throw new Error("Too many prerequisite attestations");
    const intent = args.client_batch_id && args.batch_ids ? {
      client_batch_id: args.client_batch_id, source_device_id: args.source_device_id,
      selections: args.selections, wait_for_idle_ms: args.wait_for_idle_ms,
    } : undefined;
    if (!!args.client_batch_id !== !!args.batch_ids) throw new Error("Incomplete offload request identity");
    if (intent && args.batch_ids) {
      const destinations = new Set(args.selections.map(s => s.destination_id));
      if (intent.client_batch_id.length > 100 || args.batch_ids.length !== destinations.size ||
        new Set(args.batch_ids.map(b => b.batch_id)).size !== destinations.size ||
        new Set(args.batch_ids.map(b => b.destination_id)).size !== destinations.size ||
        args.batch_ids.some(b => !destinations.has(b.destination_id) || !/^mg-[a-z0-9]{4,32}$/.test(b.batch_id))) throw new Error("Invalid offload batch identity");
      const prior = await Promise.all(args.batch_ids.map(b => ctx.db.query("migration_batches").withIndex("by_batch_id", q => q.eq("batch_id", b.batch_id)).first()));
      if (prior.some(Boolean)) {
        if (!prior.every((b, i) => b?.user_id === userId && b.to_device_id === args.batch_ids![i].destination_id && intentKey(b.resource_offload) === intentKey(intent))) throw new Error("Offload request identity was already used");
        return { checks: [], batches: prior.map(b => ({ batch_id: b!.batch_id })), replayed: true };
      }
    }
    const refuse = async (reason: string) => {
      if (!intent || !args.batch_ids || args.dry_run) throw new Error(reason);
      return { checks: [], batches: await recordRefusal(ctx, userId, intent, args.batch_ids, reason), error: reason };
    };
    const now = Date.now();
    const devices = await ctx.db.query("devices").withIndex("by_user_id", q => q.eq("user_id", userId)).collect();
    const sourceDevice = devices.find(d => d.device_id === args.source_device_id);
    if (!sourceDevice || sourceDevice.is_remote || now - sourceDevice.last_seen > RESOURCE_STALE_MS) return refuse("The source laptop is not online");
    const reports = await ctx.db.query("machine_resources").withIndex("by_user", q => q.eq("user_id", userId)).collect();
    const fresh = (r: typeof reports[number] | undefined) => r && now - r.received_at <= RESOURCE_STALE_MS && now - r.snapshot.sample.at <= RESOURCE_STALE_MS && r.snapshot.sample.at <= now + 30_000;
    const source = reports.find(r => r.device_id === args.source_device_id);
    if (!fresh(source) || !source) return refuse("Refresh the laptop's resource measurements before moving sessions");
    const checks = [];
    const groups = new Map<string, string[]>();
    for (const selection of args.selections) {
      const conv = await ctx.db.get(selection.conversation_id);
      if (!conv || conv.user_id !== userId || conv.session_id !== selection.session_id || conv.owner_device_id !== args.source_device_id) return refuse("Session ownership changed; refresh the selection");
      const blockers: string[] = [];
      const activeMove = await ctx.db.query("session_migrations").withIndex("by_conversation", q => q.eq("conversation_id", conv._id))
        .filter(q => q.and(q.neq(q.field("status"), "done"), q.neq(q.field("status"), "failed"), q.neq(q.field("status"), "cancelled"))).first();
      if (activeMove) blockers.push("This session already has a queued or active move");
      if (conv.inbox_pinned_at) blockers.push("Pinned sessions are not offered for resource offload");
      const children = await ctx.db.query("conversations").withIndex("by_parent_conversation_id", q => q.eq("parent_conversation_id", conv._id)).collect();
      const teammates = await ctx.db.query("conversations").withIndex("by_spawned_by", q => q.eq("spawned_by_conversation_id", conv._id)).collect();
      // A child still working runs its own processes on this machine. A row with
      // none is finished or ran inside the parent (a Task subagent, whose row is
      // never marked completed) and moves with it.
      const running = new Set(source.snapshot.processes.map(p => p.sessionId).filter(Boolean));
      if ([...children, ...teammates.filter(c => c.agent_team_name)].some(c => c.status !== "completed" && !c.inbox_killed_at && running.has(c.session_id))) blockers.push("This session has unfinished subagents");
      const processes = source.snapshot.processes.filter(p => p.sessionId === selection.session_id);
      if (!processes.length) blockers.push("Exclusive process ownership is no longer measured");
      if (source.snapshot.processes.some(p => p.sharedSessionIds?.includes(selection.session_id))) blockers.push("This session shares a process with other sessions");
      const target = devices.find(d => d.device_id === selection.destination_id);
      if (!target?.is_remote) blockers.push("Choose a registered cloud destination");
      const targetReport = reports.find(r => r.device_id === selection.destination_id);
      const policy = evaluateOffloadRequirements({ processes, targetPlatform: target?.platform,
        targetOnline: !!target && now - target.last_seen <= RESOURCE_STALE_MS,
        targetWakeable: !!target?.cloud_host, readiness: target?.host_readiness,
        targetSample: fresh(targetReport) ? targetReport?.snapshot.sample : undefined, now });
      const plan = planMigration({ conversations: [conv], devices, targetDeviceId: selection.destination_id, now });
      blockers.push(...policy.blockers, ...plan.skipped.map(s => s.reason));
      const unconfirmed = policy.pending.filter(p => !selection.attested.includes(p));
      checks.push({ session_id: selection.session_id, destination_id: selection.destination_id, blockers, pending: policy.pending, passed: policy.passed, unconfirmed });
      const ids = groups.get(selection.destination_id) ?? [];
      ids.push(selection.conversation_id);
      groups.set(selection.destination_id, ids);
    }
    for (const [destination, ids] of groups) {
      const targetReport = reports.find(r => r.device_id === destination);
      const selected = new Set(args.selections.filter(s => s.destination_id === destination).map(s => s.session_id));
      const total = source.snapshot.processes.filter(p => p.sessionId && selected.has(p.sessionId)).reduce((n, p) => n + p.rss, 0);
      if (ids.length > 1 && fresh(targetReport) && targetReport && total > targetReport.snapshot.sample.memoryAvailable) {
        for (const check of checks.filter(c => c.destination_id === destination)) check.blockers.push("The selected group exceeds the destination's measured available memory; choose fewer sessions");
      }
    }
    if (args.dry_run) return { checks, batches: [] };
    // A session that fails its checks stays here with its own reason; the rest
    // of the batch still moves. Without a batch identity there is nowhere to
    // record a per-session refusal, so the request is refused whole.
    const refusal = new Map(checks.filter(c => c.blockers.length || c.unconfirmed.length)
      .map(c => [c.session_id, [...c.blockers, ...c.unconfirmed.map(p => `Confirm: ${p}`)].join("; ")]));
    if (refusal.size && (!intent || !args.batch_ids)) return refuse([...refusal.values()][0]);
    const batches = [];
    for (const [to_device_id] of groups) {
      const batch_id = args.batch_ids?.find(b => b.destination_id === to_device_id)?.batch_id;
      const here = args.selections.filter(s => s.destination_id === to_device_id);
      const moving = here.filter(s => !refusal.has(s.session_id));
      const refused = here.filter(s => refusal.has(s.session_id));
      if (moving.length) {
        const result = await performCreateBatch(ctx, userId, { conversation_ids: moving.map(s => s.conversation_id), to_device_id, batch_id, resource_offload: intent, wait_for_idle_ms: args.wait_for_idle_ms, interrupt_on_timeout: false }, now);
        if (result.skipped.length) throw new Error("The selection changed during preflight; refresh and try again");
        batches.push(result);
      }
      if (refused.length && intent && batch_id) {
        await recordRefusal(ctx, userId, intent, [{ destination_id: to_device_id, batch_id }], (s) => refusal.get(s.session_id), { batchExists: moving.length > 0, position: moving.length });
        if (!moving.length) batches.push({ batch_id });
      }
    }
    const moved = batches.some(b => "rows" in b && b.rows.length > 0);
    return { checks, batches, ...(moved || !refusal.size ? {} : { error: [...refusal.values()][0] }) };
  },
});

/**
 * Record refused sessions as failed rows, so the run shows why each stayed.
 * `reason` is one string for a whole refused request, or per selection (a
 * selection it returns nothing for moved and is not recorded). `into` adds the
 * rows to a batch that already holds the sessions that did move.
 */
async function recordRefusal(ctx: { db: any }, userId: string, intent: ResourceOffloadIntent, ids: ResourceOffloadBatchId[],
  reason: string | ((s: ResourceOffloadIntent["selections"][number]) => string | undefined), into?: { batchExists: boolean; position: number }) {
  const now = Date.now();
  for (const batch of ids) {
    if (!into?.batchExists) {
      await ctx.db.insert("migration_batches", { user_id: userId, batch_id: batch.batch_id,
        to_device_id: batch.destination_id, created_at: now, updated_at: now, wait_for_idle_ms: intent.wait_for_idle_ms,
        interrupt_on_timeout: false, concurrency: 0, executor_device_ids: [], resource_offload: intent });
    }
    let position = into?.position ?? 0;
    for (const selection of intent.selections.filter(s => s.destination_id === batch.destination_id)) {
      const why = typeof reason === "string" ? reason : reason(selection);
      if (!why) continue;
      const conv = await ctx.db.get(selection.conversation_id);
      if (!conv || conv.user_id !== userId) continue;
      await ctx.db.insert("session_migrations", { user_id: userId, batch_id: batch.batch_id,
        conversation_id: conv._id, session_id: selection.session_id, ...(conv.title ? { title: conv.title } : {}),
        ...(conv.short_id ? { short_id: conv.short_id } : {}), direction: "to_cloud", from_device_id: intent.source_device_id,
        to_device_id: batch.destination_id, executor_device_id: intent.source_device_id, status: "failed",
        error: why, stage: "preflight refused; session left in place", position: position++, attempt: 0,
        created_at: now, updated_at: now, finished_at: now });
    }
  }
  return ids.map(b => ({ batch_id: b.batch_id }));
}

function intentKey(intent?: ResourceOffloadIntent) {
  return intent && JSON.stringify([intent.client_batch_id, intent.source_device_id, intent.wait_for_idle_ms,
    intent.selections.map(s => [s.conversation_id, s.session_id, s.destination_id, s.attested])]);
}
