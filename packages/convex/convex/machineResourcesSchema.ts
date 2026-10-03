import { defineTable } from "convex/server";
import { v } from "convex/values";

const kind = v.union(v.literal("agent"), v.literal("browser"), v.literal("simulator"), v.literal("tool"), v.literal("app"), v.literal("system"));
export const resourcePoint = v.object({
  at: v.number(), cpuPercent: v.optional(v.number()), memoryTotal: v.number(), memoryAvailable: v.number(),
  memoryAvailableIsEstimate: v.boolean(), compressedBytes: v.optional(v.number()), swapUsedBytes: v.optional(v.number()),
  pressure: v.union(v.literal("normal"), v.literal("elevated"), v.literal("critical"), v.literal("unknown")),
  load1: v.number(), logicalCpus: v.number(), processCount: v.optional(v.number()), threadCount: v.optional(v.number()),
  diskReadBytesPerSecond: v.optional(v.number()), diskWriteBytesPerSecond: v.optional(v.number()),
  networkReceivedBytesPerSecond: v.optional(v.number()), networkSentBytesPerSecond: v.optional(v.number()),
});
export const resourceSnapshot = v.object({
  version: v.literal(1), deviceId: v.string(), platform: v.string(), sample: resourcePoint,
  processes: v.array(v.object({
    pid: v.number(), ppid: v.number(), startedAt: v.optional(v.number()), name: v.string(), kind,
    cpu: v.number(), rss: v.number(), sessionId: v.optional(v.string()), sharedSessionIds: v.optional(v.array(v.string())),
  })),
  groups: v.array(v.object({ kind, cpu: v.number(), rss: v.number(), processCount: v.number() })),
  omittedProcessCount: v.number(), collectionDurationMs: v.number(), limitations: v.array(v.string()),
});
export const machineResourceTables = {
  machine_resources: defineTable({
    user_id: v.id("users"), device_id: v.string(), received_at: v.number(),
    snapshot: resourceSnapshot, history: v.array(resourcePoint),
  }).index("by_user", ["user_id"]).index("by_user_device", ["user_id", "device_id"]),
};
