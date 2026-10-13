// Tier 3: warm-pool selection policy. Pure function — picks which recently-active,
// agent-dead sessions to re-warm. Imports daemon.ts directly (not the stale daemon.js
// bundle).
import { test, expect } from "bun:test";
import { selectSessionsToWarm, type WarmCandidate } from "./daemon.js";

const NOW = 10_000_000;
const WINDOW = 15 * 60 * 1000;

// A dead-agent, recently-active, healthy candidate (the thing we DO want to warm).
const cand = (over: Partial<WarmCandidate>): WarmCandidate => ({
  sessionId: "s",
  status: "idle",
  tsMs: NOW - 60_000, // 1 min ago
  agentAlive: false,
  circuitOpen: false,
  fatal: false,
  ...over,
});

test("warms a recently-active session whose agent has died", () => {
  const out = selectSessionsToWarm([cand({ sessionId: "a" })], NOW, { recencyWindowMs: WINDOW, cap: 3 });
  expect(out).toEqual(["a"]);
});

test("skips sessions whose agent is already alive (already warm)", () => {
  const out = selectSessionsToWarm([cand({ sessionId: "a", agentAlive: true })], NOW, { recencyWindowMs: WINDOW, cap: 3 });
  expect(out).toEqual([]);
});

test("skips stale sessions outside the recency window", () => {
  const out = selectSessionsToWarm([cand({ sessionId: "a", tsMs: NOW - WINDOW - 1 })], NOW, { recencyWindowMs: WINDOW, cap: 3 });
  expect(out).toEqual([]);
});

test("skips non-active statuses (stopped/completed) — never resurrects finished work", () => {
  const stopped = selectSessionsToWarm([cand({ sessionId: "a", status: "stopped" })], NOW, { recencyWindowMs: WINDOW, cap: 3 });
  const completed = selectSessionsToWarm([cand({ sessionId: "b", status: "completed" })], NOW, { recencyWindowMs: WINDOW, cap: 3 });
  expect(stopped).toEqual([]);
  expect(completed).toEqual([]);
});

test("skips circuit-broken and fatally-failed sessions — never piles onto failures", () => {
  const out = selectSessionsToWarm(
    [cand({ sessionId: "a", circuitOpen: true }), cand({ sessionId: "b", fatal: true })],
    NOW,
    { recencyWindowMs: WINDOW, cap: 3 },
  );
  expect(out).toEqual([]);
});

test("respects the cap, picking the most-recently-active first", () => {
  const out = selectSessionsToWarm(
    [
      cand({ sessionId: "old", tsMs: NOW - 600_000 }),
      cand({ sessionId: "newest", tsMs: NOW - 10_000 }),
      cand({ sessionId: "mid", tsMs: NOW - 120_000 }),
    ],
    NOW,
    { recencyWindowMs: WINDOW, cap: 2 },
  );
  expect(out).toEqual(["newest", "mid"]);
});

test("cap of 0 (default / disabled) selects nothing", () => {
  const out = selectSessionsToWarm([cand({ sessionId: "a" })], NOW, { recencyWindowMs: WINDOW, cap: 0 });
  expect(out).toEqual([]);
});

test("accepts working/thinking/connected as active", () => {
  for (const status of ["working", "thinking", "connected"]) {
    const out = selectSessionsToWarm([cand({ sessionId: "a", status })], NOW, { recencyWindowMs: WINDOW, cap: 3 });
    expect(out).toEqual(["a"]);
  }
});
