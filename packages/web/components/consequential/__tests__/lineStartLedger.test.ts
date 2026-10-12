import assert from "node:assert/strict";
import { test } from "bun:test";
import { lineStartLedger } from "../lineStartLedger";
import type { LineAdmission } from "../../../lib/lineFlow";

const OFF: LineAdmission = { role: { id: "r1", handle: "quality", paused: false }, on: false, queued: 60, slots: 5, busy: 0, hands: 0, handsCap: 6 };
const fig = (l: ReturnType<typeof lineStartLedger>, label: string) => l.figures.find((f) => f.label === label)?.value;
const row = (l: ReturnType<typeof lineStartLedger>, k: string) => l.rows.find((r) => r.k === k);

test("77 waiting, 60 ready, 5 places, 6 a day: the review says how many start, the pace, the cost and what else turns on", () => {
  const l = lineStartLedger({ project: "Agent Quality", admission: OFF, waiting: 77, ready: 60, notReady: [{ count: 17, words: "a fix to decide" }], cost: { avgUsd: 3.2, runs: 12, scope: "project" }, roleOwnSwitchOff: true });
  assert.equal(fig(l, "sessions start now"), "5");
  assert.equal(fig(l, "problems waiting"), "77");
  assert.equal(fig(l, "sessions a day at most"), "6");
  assert.equal(fig(l, "a day at that limit"), "~$19");
  assert.equal(l.figures.find((f) => f.label === "a day at that limit")!.sub, "~$576 a month");
  assert.equal(row(l, "Cost")!.v, "About $3 a session, $16 for the 5 now. No dollar cap");
  assert.match(row(l, "Cost")!.sub!, /The cap is 6 sessions a day\. Priced from 12 past runs here/);
  assert.equal(row(l, "Pace")!.v, "All 60 ready in about 11 days; 17 more wait on you first");
  assert.match(row(l, "Ships")!.v, /Nothing without you/);
  assert.equal(row(l, "Limits")!.v, "6 a day, 5 at once");
  assert.match(l.lead!.v, /Also lets @quality decide for you in Agent Quality/);
  assert.match(row(l, "Each one")!.v, /Agent Quality's repo/);
  assert.equal(l.confirm, "Turn on, start 5 now");
  assert.match(l.stop, /nothing new starts/);
});

test("the places and the day's sessions bound what starts now", () => {
  assert.equal(fig(lineStartLedger({ project: "P", admission: { ...OFF, busy: 4 } }), "session starts now"), "1");
  assert.equal(fig(lineStartLedger({ project: "P", admission: { ...OFF, hands: 6 } }), "sessions start now"), "0");
  assert.equal(lineStartLedger({ project: "P", admission: { ...OFF, hands: 6 } }).confirm, "Turn on");
});

test("no measured cost, an unknown queue and a paused lead are said as such, never guessed", () => {
  const l = lineStartLedger({ project: "P", admission: { ...OFF, queued: null, role: { id: "r1", handle: "quality", paused: true } } });
  assert.equal(fig(l, "sessions start now"), "≤5");
  assert.match(row(l, "Cost")!.v, /Not priced yet, and no dollar cap/);
  assert.ok(!l.figures.some((f) => f.value.includes("$")), "no price, no dollar tile");
  assert.match(row(l, "Lead")!.v, /^@quality is paused/);
  assert.equal(l.lead, undefined);
});

test("every waiting problem starting at the press is one tile, and a price from other lines says where it came from", () => {
  const l = lineStartLedger({ project: "Broker Outreach", admission: { ...OFF, queued: 2 }, waiting: 2, ready: 2, cost: { avgUsd: 6.99, runs: 5, scope: "workspace" } });
  assert.equal(fig(l, "sessions start now"), "2");
  assert.equal(fig(l, "problems waiting"), undefined);
  assert.equal(fig(l, "a day at that limit"), "~$42");
  assert.match(row(l, "Cost")!.sub!, /5 past runs on your other projects/);
  assert.equal(row(l, "Pace"), undefined);
});
