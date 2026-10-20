import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { resourceSnapshot } from "./machineResourcesSchema";
import { RESOURCE_HISTORY_LIMIT, RESOURCE_PROCESS_LIMIT, deviceDisplayName, fmtBytes, fmtCpu, sustainedResourcePressure, type MachineResourceSnapshot, type ResourceIncident, type ResourcePoint } from "@codecast/shared/contracts";
import { emitNotification } from "./notificationRouter";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export function validateResourceSnapshot(snapshot: MachineResourceSnapshot, now: number): void {
  if (snapshot.processes.length > RESOURCE_PROCESS_LIMIT || snapshot.groups.length > 6 || snapshot.limitations.length > 12) throw new Error("Resource snapshot exceeds its bounds");
  if (Math.abs(snapshot.sample.at - now) > 300_000) throw new Error("Resource snapshot clock is stale or skewed");
  if (snapshot.deviceId.length > 128 || snapshot.platform.length > 32 || snapshot.limitations.some(s => s.length > 240)) throw new Error("Resource snapshot text exceeds its bounds");
  if (snapshot.processes.some(p => p.name.length > 120 || (p.sessionId?.length ?? 0) > 128 || (p.sharedSessionIds?.length ?? 0) > 32 || p.sharedSessionIds?.some(s => s.length > 128) || (p.localData?.root.length ?? 0) > 240)) throw new Error("Resource process exceeds its bounds");
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
  const background_sessions = existing?.background_sessions ?? [];
  if (existing && (snapshot.sample.at <= existing.snapshot.sample.at || now - existing.received_at < 15_000)) return { accepted: false, background_sessions };
  const history = [...(existing?.history ?? []).filter(p => now - p.at <= 2 * 3600_000), snapshot.sample].slice(-RESOURCE_HISTORY_LIMIT);
  const data = { user_id: userId, device_id: snapshot.deviceId, received_at: now, snapshot, history };
  const incident = device.is_remote ? null : sustainedResourcePressure(history, now);
  const alert = overloadAlertDue(incident, existing?.overload_alert, now);
  const stamp = alert ? { overload_alert: { since: alert.since, level: alert.level, at: now } } : {};
  if (existing) await ctx.db.patch(existing._id, { ...data, ...stamp });
  else await ctx.db.insert("machine_resources", { ...data, ...stamp });
  if (alert) await notifyOverload(ctx, userId, device, snapshot, alert, now);
  return { accepted: true, background_sessions };
}

/** A fresh incident after this long rings again; an escalation to critical always does. */
export const OVERLOAD_REALERT_MS = 30 * 60_000;

/**
 * Whether this sample should announce the incident: once when it starts (the
 * sample that confirmed it, so the alert is as timely as the incident itself),
 * once more if it turns critical, and a new incident only after a quiet spell,
 * so a laptop hovering at the bar does not ring every few minutes.
 */
export function overloadAlertDue(
  incident: ResourceIncident | null,
  last: { since: number; level: "elevated" | "critical"; at: number } | undefined,
  now: number,
): ResourceIncident | null {
  if (!incident) return null;
  const escalated = incident.level === "critical" && last?.level !== "critical";
  if (!last) return incident;
  if (last.since === incident.since) return escalated ? incident : null;
  return escalated || now - last.at >= OVERLOAD_REALERT_MS ? incident : null;
}

/** The notification's words: what is wrong, how bad, and which sessions are behind it. */
export function overloadMessage(input: {
  machine: string; incident: ResourceIncident; sample: ResourcePoint; now: number;
  top: Array<{ title: string; cpu: number; rss: number }>;
}): { message: string; subtitle: string; body: string } {
  const { machine, incident, sample, now, top } = input;
  const minutes = Math.max(1, Math.round((now - incident.since) / 60_000));
  const used = Math.max(0, sample.memoryTotal - sample.memoryAvailable);
  const vitals = [
    sample.cpuPercent !== undefined ? `CPU ${Math.round(sample.cpuPercent)}%` : undefined,
    `memory ${fmtBytes(used)} of ${fmtBytes(sample.memoryTotal)}`,
    sample.pressure === "elevated" || sample.pressure === "critical" ? `${sample.pressure} pressure` : undefined,
  ].filter(Boolean).join(", ");
  const heaviest = top.map((t) => `${t.title} (${fmtCpu(t.cpu)}, ${fmtBytes(t.rss)})`).join("; ");
  const reason = `${incident.reason} for ${minutes} min`;
  const body = `${vitals.charAt(0).toUpperCase()}${vitals.slice(1)}.${heaviest ? ` Heaviest: ${heaviest}.` : ""}`;
  return {
    message: `${machine} is overloaded. ${reason}. ${body} Open it to move load to the cloud.`,
    subtitle: reason,
    body,
  };
}

/** The three sessions using the machine most, by CPU then memory, from processes each owns alone. */
async function heaviestSessions(ctx: MutationCtx, snapshot: MachineResourceSnapshot) {
  const bySession = new Map<string, { cpu: number; rss: number }>();
  for (const p of snapshot.processes) {
    if (!p.sessionId) continue;
    const u = bySession.get(p.sessionId) ?? { cpu: 0, rss: 0 };
    u.cpu += p.cpu; u.rss += p.rss;
    bySession.set(p.sessionId, u);
  }
  const ranked = [...bySession].sort((a, b) => b[1].cpu - a[1].cpu || b[1].rss - a[1].rss).slice(0, 3);
  return Promise.all(ranked.map(async ([sessionId, u]) => {
    const managed = await ctx.db.query("managed_sessions").withIndex("by_session_id", q => q.eq("session_id", sessionId)).first();
    const conv = managed?.conversation_id ? await ctx.db.get(managed.conversation_id) : null;
    return { title: conv?.title?.trim() || `Session ${sessionId.slice(0, 7)}`, ...u };
  }));
}

async function notifyOverload(ctx: MutationCtx, userId: Id<"users">, device: Doc<"devices">, snapshot: MachineResourceSnapshot, incident: ResourceIncident, now: number) {
  const machine = deviceDisplayName(device);
  const words = overloadMessage({ machine, incident, sample: snapshot.sample, now, top: await heaviestSessions(ctx, snapshot) });
  await emitNotification(ctx, {
    event_type: "machine_overloaded",
    entity_type: "machine",
    entity_id: device.device_id,
    direct_recipient_id: userId,
    actor_name: machine,
    message: words.message,
    push_subtitle: words.subtitle,
    push_body: words.body,
  });
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

/** Most sessions a machine holds at background priority; the oldest request drops off past it. */
const MAX_BACKGROUND_SESSIONS = 64;

/** Puts a session's processes on one of your machines at background priority, or back. The daemon applies it on its next report. */
export const setSessionBackground = mutation({
  args: { device_id: v.string(), session_id: v.string(), background: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required");
    const row = await ctx.db.query("machine_resources").withIndex("by_user_device", q => q.eq("user_id", userId).eq("device_id", args.device_id)).unique();
    if (!row) throw new Error("That machine has not reported its resources");
    const rest = (row.background_sessions ?? []).filter(id => id !== args.session_id);
    const next = args.background ? [...rest, args.session_id].slice(-MAX_BACKGROUND_SESSIONS) : rest;
    await ctx.db.patch(row._id, { background_sessions: next });
    return { background_sessions: next };
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
