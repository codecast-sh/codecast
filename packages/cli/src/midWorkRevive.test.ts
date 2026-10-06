import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecoveryContinueClientId } from "@codecast/shared/contracts";
import {
  REVIVE_BUDGET, REVIVE_BUDGET_WINDOW_MS, REVIVE_MAX_AGE_MS,
  midWorkReviveDecision, priorRevives, recordRevive, reviveClientId, type ReviveFacts,
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
