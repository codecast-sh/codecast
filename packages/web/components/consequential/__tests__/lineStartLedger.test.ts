import assert from "node:assert/strict";
import { test } from "bun:test";
import { lineStartLedger } from "../lineStartLedger";
import type { LineAdmission } from "../../../lib/lineFlow";
import { assertGlance } from "./glance";

const OFF: LineAdmission = { role: { id: "r1", handle: "quality", paused: false }, on: false, queued: 60, slots: 5, busy: 0, hands: 0, handsCap: 6 };
type L = ReturnType<typeof lineStartLedger>;
const fig = (l: L, label: string) => l.figures.find((f) => f.label === label)?.value;
const row = (l: L, k: string) => l.rows.find((r) => r.k === k);

test("77 waiting, 60 ready, 5 at once, 6 a day: how many start, the rest, the blocked and the cost add up", () => {
  const l = lineStartLedger({ project: "Agent Quality", admission: OFF, waiting: 77, ready: 60, notReady: [{ count: 12, words: "12 need context from a person" }, { count: 5, words: "5 are assigned to someone" }], cost: { billedUsd: 3.2, listUsd: 0, runs: 12, scope: "project" }, roleOwnSwitchOff: true, first: ["Cold sends miss", "Calls drop", "Briefs stale"] });
  assertGlance(l);
  assert.equal(fig(l, "start within 2 min"), "5");
  assert.equal(fig(l, "ready"), "60");
  assert.equal(fig(l, "waiting"), undefined);
  assert.equal(fig(l, "a day, max"), "6");
  assert.equal(fig(l, "a day, billed"), "~$19");
  // The project is the subject, said once.
  assert.equal(l.subject, "Agent Quality");
  assert.equal(row(l, "Project"), undefined);
  assert.equal(row(l, "Starting")!.v, "5 problems");
  assert.deepEqual(row(l, "Starting")!.list, ["Cold sends miss", "Calls drop", "Briefs stale", "+2 more"]);
  assert.equal(row(l, "Then")!.v, "55 more, 6 a day");
  assert.equal(row(l, "Blocked")!.v, "17");
  assert.equal(row(l, "Per session")!.v, "~$3 billed · ~$0.00 list · 12-run avg");
  assert.equal(row(l, "Also on")!.v, "@quality decides alone");
  assert.equal(l.confirm, "Turn on: run all 60");
});

test("one reason for every blocked problem is named; several are counted", () => {
  const one = lineStartLedger({ project: "P", admission: { ...OFF, queued: 27 }, waiting: 31, ready: 27, notReady: [{ count: 4, words: "4 are assigned to someone" }] });
  assertGlance(one);
  assert.equal(row(one, "Blocked")!.v, "4 are assigned to someone");
  assert.equal(row(one, "Then")!.v, "22 more, 6 a day");
  assert.equal(row(lineStartLedger({ project: "P", admission: OFF, ready: 60 }), "Blocked"), undefined);
});

test("the places and the day's sessions bound what starts now", () => {
  assert.equal(fig(lineStartLedger({ project: "P", admission: { ...OFF, busy: 4 } }), "start within 2 min"), "1");
  const capped = lineStartLedger({ project: "P", admission: { ...OFF, hands: 6 } });
  assert.equal(fig(capped, "start within 2 min"), "0");
  assert.equal(capped.confirm, "Turn on");
});

test("an unknown price, an unknown queue and a paused lead are said as such, never guessed", () => {
  const l = lineStartLedger({ project: "P", admission: { ...OFF, queued: null, role: { id: "r1", handle: "quality", paused: true } } });
  assertGlance(l);
  assert.equal(fig(l, "start within 2 min"), "≤5");
  assert.equal(fig(l, "not priced"), "$?");
  assert.equal(row(l, "Lead")!.v, "@quality paused");
});

test("everything waiting starts: one count, and a borrowed price says where from", () => {
  const l = lineStartLedger({ project: "Broker Outreach", admission: { ...OFF, queued: 2 }, waiting: 2, ready: 2, cost: { billedUsd: 6.99, listUsd: 0, runs: 5, scope: "workspace" } });
  assert.equal(fig(l, "ready"), undefined);
  assert.equal(fig(l, "a day, billed"), "~$42");
  assert.equal(row(l, "Per session")!.v, "~$7 billed · ~$0.00 list · 5-run avg");
  assert.equal(row(l, "Then")!.v, "New ones as they arrive");
});

test("a lead with no daily cap: the review says no cap, loudly, and the queue runs at the places", () => {
  const l = lineStartLedger({ project: "Agent Quality", admission: { ...OFF, handsCap: null, queued: 66 }, waiting: 66, ready: 66, cost: { billedUsd: 6.99, listUsd: 0, runs: 5, scope: "workspace" } });
  assertGlance(l);
  assert.equal(fig(l, "a day, no limit"), "∞");
  assert.equal(fig(l, "all, billed"), "~$461");
  assert.equal(row(l, "Then")!.v, "61 more, 5 at a time");
});

test("a role with no daily cap gets one picked in the review: the figures read the pick, never an endless day", () => {
  const a: LineAdmission = { role: { id: "r", handle: "callers-lead", paused: false }, on: false, slots: 5, busy: 0, hands: null, handsCap: null, queued: 27 };
  const l = lineStartLedger({ project: "Callers", admission: a, ready: 27, dayCap: 10 });
  assert.deepEqual(l.pick, { k: "A day", options: ["5", "10", "20", "No limit"], value: "10" });
  assert.ok(l.figures.some((f) => f.label === "a day, max" && f.value === "10"));
  assert.ok(!l.figures.some((f) => f.value === "∞"));
  assert.equal(l.rows.find((r) => r.k === "Then")?.v, "22 more, 10 a day");
  // Picking no cap says so, loudly; a role that has a cap is offered no pick.
  assert.equal(lineStartLedger({ project: "Callers", admission: a, ready: 27, dayCap: null }).pick?.value, "No limit");
  assert.equal(lineStartLedger({ project: "Callers", admission: { ...a, handsCap: 6, hands: 0 }, ready: 27, dayCap: 10 }).pick, undefined);
  assertGlance(l);
});

test("Starting names every problem a press starts, in full; only unnamed ones are counted", () => {
  const l = lineStartLedger({ project: "Callers", admission: OFF, waiting: 30, ready: 28, first: ["a", "b", "c", "d", "e"] });
  assert.deepEqual(row(l, "Starting")!.list, ["a", "b", "c", "d", "e"]);
});

test("nothing starts now over ready problems: the review says why and names the ones that start first (Callers, 0 over 34)", () => {
  const used: LineAdmission = { role: { id: "r", handle: "callers-lead", paused: false }, on: false, slots: 5, busy: 0, hands: 10, handsCap: 10, queued: 34 };
  const l = lineStartLedger({ project: "Callers", admission: used, ready: 34, first: ["a", "b", "c", "d", "e", "f"] });
  assert.equal(fig(l, "start within 2 min"), "0");
  assert.equal(row(l, "Not now")!.v, "Today's 10 sessions used: tomorrow");
  assert.deepEqual(row(l, "Starts first")!.list, ["a", "b", "c", "d", "e"]);
  // The named first five and Then add up to the ready figure, never 5 + 34.
  assert.equal(row(l, "Then")!.v, "29 more, 10 a day");
  assertGlance(l);
  const full = lineStartLedger({ project: "Callers", admission: { ...used, hands: 2, busy: 5 }, ready: 34, first: ["a", "b"] });
  assert.match(row(full, "Not now")!.v, /^All 5 places await decisions$/);
  assertGlance(full);
});
