import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecoveryContinueClientId } from "@codecast/shared/contracts";
import {
  REVIVE_BUDGET, REVIVE_BUDGET_WINDOW_MS, REVIVE_MAX_AGE_MS, UNFINISHED_STATUS_FILE_TTL_MS,
  lastSignOfLifeMs, midWorkReviveDecision, priorRevives, recordRevive, reviveClientId, statusFileExpired, type ReviveFacts,
} from "./midWorkRevive.js";

const NOW = Date.parse("2026-10-05T05:01:05Z");
const MIN = 60_000;
const visible = { hideStateKnown: true, inboxKilledAt: null, inboxDismissedAt: null };

function facts(over: Partial<ReviveFacts> = {}): ReviveFacts {
  return {
    status: "waiting", ageMs: 59 * MIN, lifecycle: visible,
    interruptedByUser: false, limitParked: false, priorRevives: [], now: NOW,
    ...over,
  };
}

describe("midWorkReviveDecision", () => {
  // jx7e4fy on 2026-10-05: its process died at 05:00Z while it waited on the
  // "line-polish" workflow; the watchdog marked it completed at 05:01Z and it
  // sat stopped for eight hours until a person typed into it.
  test("revives a session that died while waiting on its own background work", () => {
    expect(midWorkReviveDecision(facts())).toEqual({ revive: true });
  });

  test("revives every mid-turn status", () => {
    for (const status of ["working", "thinking", "compacting", "waiting"]) {
      expect(midWorkReviveDecision(facts({ status })).revive).toBe(true);
    }
  });

  test("leaves a finished turn, a permission prompt and a trigger wait alone", () => {
    for (const status of ["idle", "stopped", "permission_blocked", "dormant", undefined]) {
      expect(midWorkReviveDecision(facts({ status }))).toEqual({ revive: false, reason: "turn-finished" });
    }
  });

  test("does not wake work that died long ago", () => {
    expect(midWorkReviveDecision(facts({ ageMs: REVIVE_MAX_AGE_MS + 1 }))).toEqual({ revive: false, reason: "too-old" });
  });

  test("respects the person: killed, dismissed, or interrupted stays stopped", () => {
    expect(midWorkReviveDecision(facts({ lifecycle: { ...visible, inboxKilledAt: NOW - MIN } })).revive).toBe(false);
    expect(midWorkReviveDecision(facts({ lifecycle: { ...visible, inboxDismissedAt: NOW - MIN } })).revive).toBe(false);
    expect(midWorkReviveDecision(facts({ interruptedByUser: true }))).toEqual({ revive: false, reason: "interrupted" });
  });

  test("a stashed session keeps running by design, so it is revived", () => {
    expect(midWorkReviveDecision(facts({ lifecycle: { ...visible, inboxStashedAt: NOW - MIN } as never })).revive).toBe(true);
  });

  test("unknown hide state falls back to closing it", () => {
    expect(midWorkReviveDecision(facts({ lifecycle: null })).revive).toBe(false);
    expect(midWorkReviveDecision(facts({ lifecycle: { hideStateKnown: false } })).revive).toBe(false);
  });

  test("a limit park belongs to the account recovery chain", () => {
    expect(midWorkReviveDecision(facts({ limitParked: true }))).toEqual({ revive: false, reason: "limit-parked" });
  });

  test("stops after the budget inside the window, and the window rolls", () => {
    const spent = Array.from({ length: REVIVE_BUDGET }, (_, i) => NOW - (i + 1) * 30 * MIN);
    expect(midWorkReviveDecision(facts({ priorRevives: spent }))).toEqual({ revive: false, reason: "budget-spent" });
    const old = spent.map((t) => t - REVIVE_BUDGET_WINDOW_MS);
    expect(midWorkReviveDecision(facts({ priorRevives: old })).revive).toBe(true);
  });
});

describe("revive ledger", () => {
  test("records revives, survives a re-read, and prunes outside the window", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "revive-")), "revives.json");
    expect(priorRevives(file, "a")).toEqual([]);
    recordRevive(file, "old", NOW - REVIVE_BUDGET_WINDOW_MS - MIN);
    recordRevive(file, "a", NOW - MIN);
    recordRevive(file, "a", NOW);
    expect(priorRevives(file, "a")).toEqual([NOW - MIN, NOW]);
    expect(priorRevives(file, "old")).toEqual([]);
  });

  test("a corrupt ledger reads as empty instead of blocking revives", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "revive-")), "revives.json");
    fs.writeFileSync(file, "{not json");
    expect(priorRevives(file, "a")).toEqual([]);
    recordRevive(file, "a", NOW);
    expect(priorRevives(file, "a")).toEqual([NOW]);
  });
});

test("the revive message reads as the system's, not the person's", () => {
  expect(isRecoveryContinueClientId(reviveClientId("jx7e4fydgv2are6sv3gdkp78n58fg737", NOW))).toBe(true);
  expect(reviveClientId("c", NOW)).toBe(reviveClientId("c", NOW + 30_000));
});

// fdf643a3 on 2026-10-06: its turn ended at 02:00Z with a workflow running, the
// half-hourly cleanup deleted its hour-old "waiting" file at 04:36Z, and when
// the process died at 04:41Z the watchdog had nothing to find. The workflow
// sat dead until a person typed "continue" an hour later.
describe("status file retention", () => {
  const HOUR = 60 * MIN;

  test("keeps an unfinished turn's file while its workflow runs for hours", () => {
    for (const status of ["working", "thinking", "compacting", "waiting"]) {
      expect(statusFileExpired(status, NOW - 3 * HOUR, NOW, HOUR)).toBe(false);
    }
  });

  test("expires a finished turn's file after the short ttl", () => {
    for (const status of ["idle", "stopped", "permission_blocked", undefined]) {
      expect(statusFileExpired(status, NOW - 2 * HOUR, NOW, HOUR)).toBe(true);
      expect(statusFileExpired(status, NOW - 30 * MIN, NOW, HOUR)).toBe(false);
    }
  });

  test("still clears an unfinished file nobody settles", () => {
    expect(statusFileExpired("waiting", NOW - UNFINISHED_STATUS_FILE_TTL_MS - MIN, NOW, HOUR)).toBe(true);
  });

  test("the cleanup asks the retention rule instead of a bare mtime cutoff", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "daemon.ts"), "utf8");
    const block = src.slice(src.indexOf("Clean up stale agent-status files"), src.indexOf("const CLAUDE_PLANS_DIR"));
    expect(block).toContain("statusFileExpired(f.data?.status, f.mtimeMs");
    expect(block).not.toMatch(/f\.mtimeMs\s*>=\s*cutoff/);
  });
});

describe("lastSignOfLifeMs", () => {
  function touch(file: string, atMs: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n");
    fs.utimesSync(file, atMs / 1000, atMs / 1000);
  }

  // The parent's transcript stops moving when its turn ends; the workflow's
  // agents keep writing until the process dies with them.
  test("reads the newest write across the transcript and every agent it hosted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revive-life-"));
    const transcript = path.join(dir, "sid.jsonl");
    touch(transcript, NOW - 160 * MIN);
    touch(path.join(dir, "sid", "subagents", "agent-a.jsonl"), NOW - 90 * MIN);
    touch(path.join(dir, "sid", "subagents", "workflows", "wf_1", "agent-b.jsonl"), NOW - 6 * MIN);
    touch(path.join(dir, "sid", "subagents", "workflows", "wf_0", "agent-c.jsonl"), NOW - 120 * MIN);
    expect(await lastSignOfLifeMs(transcript)).toBe(NOW - 6 * MIN);
  });

  test("falls back to the transcript alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revive-life-"));
    const transcript = path.join(dir, "sid.jsonl");
    touch(transcript, NOW - 20 * MIN);
    expect(await lastSignOfLifeMs(transcript)).toBe(NOW - 20 * MIN);
  });

  // A workflow longer than the revive age bound: the status is from the turn's
  // end, but the session was alive minutes ago, so it is revived.
  test("a workflow that outran the age bound is still revived", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revive-life-"));
    const transcript = path.join(dir, "sid.jsonl");
    touch(transcript, NOW - REVIVE_MAX_AGE_MS - 60 * MIN);
    touch(path.join(dir, "sid", "subagents", "workflows", "wf_1", "agent-a.jsonl"), NOW - 8 * MIN);
    const statusAge = REVIVE_MAX_AGE_MS + 60 * MIN;
    expect(midWorkReviveDecision(facts({ ageMs: statusAge })).revive).toBe(false);
    const ageMs = Math.min(statusAge, NOW - await lastSignOfLifeMs(transcript));
    expect(midWorkReviveDecision(facts({ ageMs }))).toEqual({ revive: true });
  });
});
