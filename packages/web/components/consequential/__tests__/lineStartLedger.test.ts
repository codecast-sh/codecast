import assert from "node:assert/strict";
import { test } from "bun:test";
import { lineStartLedger } from "../lineStartLedger";
import type { LineAdmission } from "../../../lib/lineFlow";
import { assertGlance } from "./glance";

const OFF: LineAdmission = { role: { id: "r1", handle: "quality", paused: false }, on: false, queued: 60, slots: 5, busy: 0, hands: 0, handsCap: 6 };
type L = ReturnType<typeof lineStartLedger>;
const fig = (l: L, label: string) => l.figures.find((f) => f.label === label)?.value;
const row = (l: L, k: string) => l.rows.find((r) => r.k === k);

test("77 waiting, 60 ready, 5 at once, 6 a day: how many start, the pace and the cost, all at a glance", () => {
  const l = lineStartLedger({ project: "Agent Quality", admission: OFF, waiting: 77, ready: 60, notReady: [{ count: 17, words: "a fix to decide" }], cost: { avgUsd: 3.2, runs: 12, scope: "project" }, roleOwnSwitchOff: true, first: ["ct-1", "ct-2", "ct-3"] });
  assertGlance(l);
  assert.equal(fig(l, "start within 2 min"), "5");
  assert.equal(fig(l, "waiting"), "77");
  assert.equal(fig(l, "a day, max"), "6");
  assert.equal(fig(l, "a day, est."), "~$19");
  assert.equal(row(l, "Repo")!.v, "Agent Quality");
  assert.equal(row(l, "Starting")!.v, "ct-1 · ct-2 · ct-3 · +2");
  assert.equal(row(l, "Then")!.v, "All 60 in ~11 days");
  assert.equal(row(l, "Held")!.v, "17 wait on you");
  assert.equal(row(l, "Per session")!.v, "~$3 · 12-run avg");
  assert.equal(row(l, "Also on")!.v, "@quality decides alone");
  assert.equal(l.confirm, "Run all 60");
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
  const l = lineStartLedger({ project: "Broker Outreach", admission: { ...OFF, queued: 2 }, waiting: 2, ready: 2, cost: { avgUsd: 6.99, runs: 5, scope: "workspace" } });
  assert.equal(fig(l, "waiting"), undefined);
  assert.equal(fig(l, "a day, est."), "~$42");
  assert.equal(row(l, "Per session")!.v, "~$7 · 5-run avg");
  assert.equal(row(l, "Then")!.v, "New ones as they arrive");
});

test("a lead with no daily cap: the review says no cap, loudly, and the queue runs at the places", () => {
  const l = lineStartLedger({ project: "Agent Quality", admission: { ...OFF, handsCap: null, queued: 66 }, waiting: 66, ready: 66, cost: { avgUsd: 6.99, runs: 5, scope: "workspace" } });
  assertGlance(l);
  assert.equal(fig(l, "a day, no cap"), "∞");
  assert.equal(fig(l, "all 66, est."), "~$461");
  assert.equal(row(l, "Then")!.v, "All 66, 5 at a time");
});
