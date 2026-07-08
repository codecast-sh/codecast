import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for the "session stuck in 'working' forever" bug
// (root-caused 2026-04-14). See session jx71srp + jx7a2ef for history.
//
// The server's agent_status field was only refreshed on discrete transition
// events (sendAgentStatus -> updateSessionAgentStatus). If a transition was
// dropped (daemon bug, network failure, or the "idle" transition simply never
// fired), the session appeared stuck in its last-reported state indefinitely
// while the heartbeat kept ticking.
//
// The fix: heartbeat carries agent_status, so every 30s the server re-syncs
// from the daemon's local lastSentAgentStatus map. Self-heals any dropped
// transition within one heartbeat interval.
//
// This test guards against a regression where someone reverts the callsites
// to call heartbeatManagedSession(sessionId) without the status arg.

const daemonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "daemon.ts",
);
const syncServicePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "syncService.ts",
);
const daemonSource = fs.readFileSync(daemonPath, "utf8");
const syncServiceSource = fs.readFileSync(syncServicePath, "utf8");

describe("heartbeat carries agent_status", () => {
  test("syncService.heartbeatManagedSession accepts an agentStatus param", () => {
    const sig =
      /async\s+heartbeatManagedSession\s*\(\s*sessionId:\s*string,\s*agentStatus\?:/;
    expect(syncServiceSource).toMatch(sig);
  });

  test("syncService forwards agent_status + client_ts to the mutation when provided", () => {
    const forward =
      /agentStatus\s*\?\s*\{\s*agent_status:\s*agentStatus,\s*client_ts:\s*Date\.now\(\)\s*\}/;
    expect(syncServiceSource).toMatch(forward);
  });

  test("syncService exposes a batched heartbeat that forwards to the batch mutation", () => {
    // Heartbeats are now flushed for the whole fleet in one batched mutation per
    // tick (collapsing the inbox-invalidation storm), not one call per session.
    expect(syncServiceSource).toMatch(/async\s+heartbeatManagedSessionsBatch\s*\(/);
    expect(syncServiceSource).toContain("managedSessions:heartbeatBatch");
  });

  test("the batched flush carries agent_status sourced from lastSentAgentStatus", () => {
    // The 'stuck working' guard holds only if the batch payload carries each
    // session's agent_status, read from the local lastSentAgentStatus map (not a
    // stale or fabricated value). Pin that the flush builds its payload that way.
    const idx = daemonSource.indexOf("async function flushManagedHeartbeats");
    expect(idx).toBeGreaterThanOrEqual(0);
    const body = daemonSource.slice(idx, idx + 2000);
    expect(body).toContain("lastSentAgentStatus.get(sessionId)");
    expect(body).toContain("agent_status: status");
  });

  test("managed started sessions stamp the real session id onto tmux", () => {
    const idx = daemonSource.indexOf("function registerManagedStartedSession");
    expect(idx).toBeGreaterThanOrEqual(0);
    // Slice the whole function body (up to its column-0 closing brace) rather
    // than a fixed byte window — a fixed window silently overflows when a
    // comment is added inside the function, failing on behavior that is intact.
    const body = daemonSource.slice(idx, daemonSource.indexOf("\n}", idx));
    expect(body).toContain('"@codecast_conversation_id"');
    expect(body).toContain('"@codecast_session_id"');
    expect(body).toContain("registerManagedSession(sessionId");
  });

  test("the batch mutation reuses the single heartbeat's status-patch logic", () => {
    // Both heartbeat paths must compute the agent_status patch identically (the
    // change-only agent_status_updated_at rule), or the batched path could
    // reintroduce the latched-status bug. They share buildHeartbeatPatch.
    const managedSessionsSource = fs.readFileSync(
      path.join(path.dirname(daemonPath), "..", "..", "convex", "convex", "managedSessions.ts"),
      "utf8",
    );
    expect(managedSessionsSource).toContain("function buildHeartbeatPatch(");
    const batchIdx = managedSessionsSource.indexOf("export const heartbeatBatch");
    expect(batchIdx).toBeGreaterThanOrEqual(0);
    expect(managedSessionsSource.slice(batchIdx, batchIdx + 1500)).toContain("buildHeartbeatPatch(");
  });

  test("logHeartbeatStatus helper is defined and called in the flush", () => {
    // Helper must exist so we can diagnose 'stuck in X' from logs.
    expect(daemonSource).toContain("function logHeartbeatStatus(");
    const calls = [...daemonSource.matchAll(/logHeartbeatStatus\s*\(/g)];
    // declaration + at least one call site (the per-session loop in the flush).
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
