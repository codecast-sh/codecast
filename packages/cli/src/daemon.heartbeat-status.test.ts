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

  test("every heartbeatManagedSession call from daemon.ts passes a status argument", () => {
    // Find every heartbeatManagedSession(...) call-site in daemon.ts
    const callPattern = /heartbeatManagedSession\s*\(([^)]*)\)/g;
    const calls: Array<{ args: string; line: number }> = [];
    for (const m of daemonSource.matchAll(callPattern)) {
      const line =
        daemonSource.slice(0, m.index ?? 0).split("\n").length;
      calls.push({ args: m[1].trim(), line });
    }
    // We expect at least the three interval call-sites to exist.
    expect(calls.length).toBeGreaterThanOrEqual(3);

    // Each call must pass two arguments (sessionId + a status var/literal).
    // The second arg proves heartbeat is carrying status -- empty single-arg
    // calls reintroduce the 'stuck working' bug.
    const bad = calls.filter((c) => {
      const parts = c.args.split(",").map((p) => p.trim()).filter(Boolean);
      return parts.length < 2;
    });
    if (bad.length > 0) {
      const summary = bad
        .map(
          (c) =>
            `  - line ${c.line}: heartbeatManagedSession(${c.args}) is missing the status arg`,
        )
        .join("\n");
      throw new Error(
        `Found ${bad.length} heartbeat call-site(s) not carrying agent_status. This reintroduces the 'stuck working' bug:\n${summary}`,
      );
    }
    expect(bad.length).toBe(0);
  });

  test("daemon.ts sources the heartbeat status from lastSentAgentStatus in each interval", () => {
    // At each call-site, the surrounding ~6 lines must include
    // `lastSentAgentStatus.get(sessionId)` -- the local map of last-reported
    // statuses. Without this, the heartbeat would carry a stale or fabricated
    // status.
    const callIndices: number[] = [];
    const callRe = /heartbeatManagedSession\s*\(/g;
    for (const m of daemonSource.matchAll(callRe)) {
      callIndices.push(m.index ?? 0);
    }
    expect(callIndices.length).toBeGreaterThanOrEqual(3);

    const bad: Array<{ line: number; context: string }> = [];
    for (const idx of callIndices) {
      const windowStart = daemonSource.lastIndexOf("\n", idx - 1);
      // Look back up to ~400 chars for the status source line.
      const contextStart = Math.max(0, windowStart - 400);
      const context = daemonSource.slice(contextStart, idx);
      if (!context.includes("lastSentAgentStatus.get(sessionId)")) {
        const line = daemonSource.slice(0, idx).split("\n").length;
        bad.push({ line, context: context.slice(-120).replace(/\s+/g, " ") });
      }
    }
    if (bad.length > 0) {
      const summary = bad
        .map((b) => `  - line ${b.line}: preceding context: ...${b.context}`)
        .join("\n");
      throw new Error(
        `Found ${bad.length} heartbeat call-site(s) whose status arg is not sourced from lastSentAgentStatus.get:\n${summary}`,
      );
    }
    expect(bad.length).toBe(0);
  });

  test("logHeartbeatStatus helper is defined and called at each heartbeat interval", () => {
    // Helper must exist so we can diagnose 'stuck in X' from logs.
    expect(daemonSource).toContain("function logHeartbeatStatus(");
    // And it must be invoked at each heartbeat site -- at least 3 calls.
    const callRe = /logHeartbeatStatus\s*\(/g;
    const calls = [...daemonSource.matchAll(callRe)];
    // One declaration site (function logHeartbeatStatus(...)) + 3+ call sites.
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});
