import assert from "node:assert/strict";
import { test } from "bun:test";
import * as L from "../ledgers";
import { ledgerLines, roleOnlineLedger } from "../roleOnline";
import { assertGlance } from "./glance";

const cost = { billedUsd: 6.99, listUsd: 0, runs: 5, scope: "workspace" as const };

test("every ledger reads at a glance: no sentence, no long value", () => {
  const all = [
    L.roleAutonomyLedger({ name: "Broker Outreach lead", handle: "broker-outreach", caps: { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400_000 }, usedToday: 0, projects: ["Broker Outreach"], merges: false, cost }),
    L.roleAutonomyLedger({ name: "Lead", handle: "x", caps: { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400_000 }, projects: ["A", "B", "C"], merges: true }),
    L.roleAutonomyLedger({ name: "Lead", handle: "x", caps: {}, projects: [], merges: false, cost }),
    L.mergeStepLedger({ name: "Growth", limit: 3, used: 1 }),
    L.mergeStepLedger({ name: "Growth", limit: null, used: 0 }),
    L.issueSpawnLedger({ provider: "GitHub", source: "acme/app", label: "agent", assignee: "bot" }),
    L.issuePushLedger({ provider: "Linear", source: "Platform" }),
    L.allowAllLedger({ pending: 3 }),
    L.shareInFullLedger({ team: "Union", others: 4, sees: "summaries" }),
    L.startAgainLedger({ problem: "Cold sends", project: "Broker Outreach", branch: true, cost, about: "20 min" }),
    L.startTheseAgainLedger({ cause: "Tests time out", count: 3, projects: ["A"], cost }),
    L.prMergeLedger({ title: "Fix login", number: 52, base: "main", head: "fix", method: "Squash and merge", deleteBranch: true, files: 5, additions: 143, deletions: 6, checks: "failure" }),
    L.agentFullAccessLedger({ agent: "Codex", label: "Full access", from: "Default", sandbox: false }),
    L.featuresAllLedger({ group: "Browser", machine: "MacBook", names: ["Browser", "Computer"] }),
    L.routineActivateLedger({ title: "Ads daily", every: "1d", applies: true, cost }),
    L.killSessionsLedger({ total: 3, working: ["Busy one"] }),
    L.restartInTmuxLedger({ terminal: "Ghostty", working: false }),
    L.restartInTmuxLedger({ terminal: "Alacritty", working: true }),
    roleOnlineLedger({ handle: "growth", name: "Growth lead", host: "Ashot", startsOnItsOwn: true, sessionsPerDay: 6 }),
  ];
  for (const l of all) assertGlance(l);
});

test("failing checks are the loudest thing on a merge, and the button says it merges anyway", () => {
  const l = L.prMergeLedger({ title: "Fix login", number: 52, base: "main", method: "Squash and merge", deleteBranch: true, checks: "failure" });
  assert.equal(l.alert, "Checks failing");
  assert.equal(l.confirm, "Merge anyway");
  assert.equal(L.prMergeLedger({ title: "x", number: 1, base: "main", method: "m", deleteBranch: false, checks: "success" }).alert, undefined);
});

test("a role's review splits what it decides from what stays with you", () => {
  const l = L.roleAutonomyLedger({ name: "Lead", handle: "x", caps: { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400_000 }, projects: ["A"], merges: false, cost });
  assert.deepEqual(l.hands!.yours, ["Approving fixes", "Merge, deploy", "Switching it off"]);
  assert.equal(l.figures.find((f) => f.label === "a day, billed")!.value, "~$42");
});

test("the phone's alert gets the same facts as lines", () => {
  const on = ledgerLines(roleOnlineLedger({ handle: "growth", name: "Growth lead", host: "Ashot", startsOnItsOwn: true, sessionsPerDay: 6 }));
  assert.ok(on.includes("6 a day, unasked"));
  assert.ok(on.includes("To stop: Pause or retire"));
});

test("a role with no daily cap says so, never a default", () => {
  const l = L.roleAutonomyLedger({ name: "Lead", handle: "x", caps: {}, projects: [], merges: false });
  assert.equal(l.figures[0].value, "∞");
  assert.equal(l.rows.find((r) => r.k === "Tokens")!.v, "No limit");
});

test("start these again at the line's pace: what starts now, what waits, and the line off said first", () => {
  const l = L.startTheseAgainLedger({ cause: "Its session never started at Prove", count: 5, rest: 24, slots: 5, first: ["a", "b", "c", "d", "e"], projects: ["Agent Quality"], hold: "Flow off: only a press starts a run" });
  assert.equal(l.alert, "Flow off: only a press starts a run");
  assert.deepEqual(l.figures.map((f) => `${f.value} ${f.label}`), ["5 runs start now", "24 wait here", "$? not priced"]);
  assert.equal(l.rows.find((r) => r.k === "Then")?.v, "24 stay here until you press again");
  assert.deepEqual(l.rows.find((r) => r.k === "Starting")?.list, ["a", "b", "c", "d", "e"]);
  assert.equal(l.confirm, "Start 5 runs");
  // Nothing free: the press is blocked with the reason.
  assert.equal(L.startTheseAgainLedger({ cause: "x", count: 0, rest: 4, slots: 5, projects: [], hold: "All 5 places taken" }).blocked, "All 5 places taken");
});

test("rotating a key says what the old key carries and when it stops, at a glance", () => {
  const kept = L.rotateKeyLedger({ source: "union-errors", prefix: "cc_ing_ab12", events24h: 2001, choice: "24h more" });
  const ended = L.rotateKeyLedger({ source: "union-errors", prefix: "cc_ing_ab12", events24h: 2001, choice: "Ends now" });
  for (const l of [kept, ended]) assertGlance(l);
  assert.equal(kept.alert, undefined);
  assert.deepEqual(kept.figures.map((f) => f.value), ["2,001", "In 24h"]);
  // Ending the old key at once refuses a busy source's sends: said loudest, before the confirm.
  assert.equal(ended.alert, "Sends refused until redeploy");
  assert.deepEqual(ended.figures.map((f) => [f.value, f.tone]), [["2,001", "warn"], ["Now", "warn"]]);
  assert.deepEqual(ended.pick, { k: "Old key", options: L.OLD_KEY_CHOICES, value: "Ends now" });
  // A source that sent nothing loses nothing: no alarm.
  assert.equal(L.rotateKeyLedger({ source: "quiet", events24h: 0, choice: "Ends now" }).alert, undefined);
});

test("moving a session to tmux warns about a turn in progress only while one runs", () => {
  const busy = L.restartInTmuxLedger({ terminal: "Ghostty", working: true });
  assert.equal(busy.alert, "It is working now");
  assert.ok(busy.rows.some((r) => r.k === "Lost"));
  const idle = L.restartInTmuxLedger({ terminal: "Ghostty", working: false });
  assert.equal(idle.alert, undefined);
  assert.ok(!idle.rows.some((r) => r.k === "Lost"));
});
