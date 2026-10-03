import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { resourceSnapshot } from "./machineResourcesSchema";
import { RESOURCE_HISTORY_LIMIT, RESOURCE_PROCESS_LIMIT, type MachineResourceSnapshot } from "@codecast/shared/contracts";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export function validateResourceSnapshot(snapshot: MachineResourceSnapshot, now: number): void {
  if (snapshot.processes.length > RESOURCE_PROCESS_LIMIT || snapshot.groups.length > 6 || snapshot.limitations.length > 12) throw new Error("Resource snapshot exceeds its bounds");
  if (Math.abs(snapshot.sample.at - now) > 300_000) throw new Error("Resource snapshot clock is stale or skewed");
  if (snapshot.deviceId.length > 128 || snapshot.platform.length > 32 || snapshot.limitations.some(s => s.length > 240)) throw new Error("Resource snapshot text exceeds its bounds");
  if (snapshot.processes.some(p => p.name.length > 120 || (p.sessionId?.length ?? 0) > 128 || (p.sharedSessionIds?.length ?? 0) > 32 || p.sharedSessionIds?.some(s => s.length > 128))) throw new Error("Resource process exceeds its bounds");
  const finite = (value: unknown): boolean => typeof value === "number" ? Number.isFinite(value) && value >= 0 : Array.isArray(value) ? value.every(finite) : value && typeof value === "object" ? Object.values(value).every(finite) : true;
  if (!finite(snapshot)) throw new Error("Invalid resource measurement");
  if (snapshot.sample.memoryAvailable > snapshot.sample.memoryTotal || (snapshot.sample.cpuPercent ?? 0) > 100 || snapshot.sample.logicalCpus < 1) throw new Error("Invalid machine totals");
  if (new Set(snapshot.processes.map(p => p.pid)).size !== snapshot.processes.length) throw new Error("Duplicate resource process");
  if (snapshot.sample.processCount === undefined && (snapshot.processes.length || snapshot.groups.length || snapshot.omittedProcessCount)) throw new Error("Unavailable process measurements cannot carry attribution");
}

export async function storeResourceSnapshot(ctx: MutationCtx, userId: Id<"users">, snapshot: MachineResourceSnapshot, now = Date.now()) {
  validateResourceSnapshot(snapshot, now);
  const device = await ctx.db.query("devices").withIndex("by_user_device", q => q.eq("user_id", userId).eq("device_id", snapshot.deviceId)).unique();
  if (!device) throw new Error("Machine is not registered to this user");
  const existing = await ctx.db.query("machine_resources").withIndex("by_user_device", q => q.eq("user_id", userId).eq("device_id", snapshot.deviceId)).unique();
  if (existing && (snapshot.sample.at <= existing.snapshot.sample.at || now - existing.received_at < 15_000)) return { accepted: false };
  const history = [...(existing?.history ?? []).filter(p => now - p.at <= 2 * 3600_000), snapshot.sample].slice(-RESOURCE_HISTORY_LIMIT);
  const data = { user_id: userId, device_id: snapshot.deviceId, received_at: now, snapshot, history };
  if (existing) await ctx.db.patch(existing._id, data);
  else await ctx.db.insert("machine_resources", data);
  return { accepted: true };
}

export const report = mutation({
  args: { api_token: v.string(), snapshot: resourceSnapshot },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Authentication required");
    const token = await ctx.db.get(auth.tokenId);
    if (token?.device_id && token.device_id !== args.snapshot.deviceId) throw new Error("The reporting token belongs to another machine");
    return storeResourceSnapshot(ctx, auth.userId, args.snapshot);
  },
});

export async function listResourceSnapshots(ctx: QueryCtx, userId: Id<"users">) {
  const rows = await ctx.db.query("machine_resources").withIndex("by_user", q => q.eq("user_id", userId)).take(100);
  const devices = await ctx.db.query("devices").withIndex("by_user_id", q => q.eq("user_id", userId)).collect();
  const ids = new Set(devices.map(d => d.device_id));
  return rows.filter(r => ids.has(r.device_id));
}

export const listMine = query({
  args: {},
  handler: async ctx => {
    const userId = await getAuthUserId(ctx);
    return userId ? listResourceSnapshots(ctx, userId) : [];
  },
});
