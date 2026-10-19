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
    cpu: v.number(), rss: v.number(), sessionId: v.optional(v.string()), sharedSessionIds: v.optional(v.array(v.string())), // `true` came from the first daemons to report it, before the route was recorded.
    detached: v.optional(v.union(v.literal("tmux"), v.literal("background"), v.literal(true))),
    localData: v.optional(v.object({ bytes: v.number(), files: v.number(), root: v.string() })),
    background: v.optional(v.literal(true)),
  })),
  groups: v.array(v.object({ kind, cpu: v.number(), rss: v.number(), processCount: v.number() })),
  omittedProcessCount: v.number(), collectionDurationMs: v.number(), limitations: v.array(v.string()),
});
export const machineResourceTables = {
  machine_resources: defineTable({
    user_id: v.id("users"), device_id: v.string(), received_at: v.number(),
    snapshot: resourceSnapshot, history: v.array(resourcePoint),
    // The last overload notification for this machine (machineResources.overloadAlertDue):
    // the incident it announced, so one incident rings once, and when.
    overload_alert: v.optional(v.object({ since: v.number(), level: v.union(v.literal("elevated"), v.literal("critical")), at: v.number() })),
    // Sessions a person put at background priority on this machine. Handed to
    // the daemon with every report answer; it lowers each process they own.
    background_sessions: v.optional(v.array(v.string())),
  }).index("by_user", ["user_id"]).index("by_user_device", ["user_id", "device_id"]),
};
