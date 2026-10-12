import assert from "node:assert/strict";
import { test } from "bun:test";
import { lineStartLedger } from "../lineStartLedger";
import type { LineAdmission } from "../../../lib/lineFlow";

const OFF: LineAdmission = { role: { id: "r1", handle: "quality", paused: false }, on: false, queued: 60, slots: 5, busy: 0, hands: 0, handsCap: 6 };
const fig = (l: ReturnType<typeof lineStartLedger>, label: string) => l.figures.find((f) => f.label === label)?.value;
const row = (l: ReturnType<typeof lineStartLedger>, k: string) => l.rows.find((r) => r.k === k);

test("77 waiting, 60 ready, 5 places, 6 a day: the review says how many start, the pace, the cost and what else turns on", () => {
  const l = lineStartLedger({ project: "Agent Quality", admission: OFF, waiting: 77, ready: 60, notReady: [{ count: 17, words: "a fix to decide" }], cost: { avgUsd: 3.2, runs: 12 }, roleOwnSwitchOff: true });
  assert.equal(fig(l, "sessions start now"), "5");
  assert.equal(fig(l, "problems waiting"), "77");
  assert.equal(fig(l, "at a time"), "5");
  assert.equal(fig(l, "a day at most"), "6");
  assert.equal(row(l, "Cost")!.v, "About $3.20 a run, so at most about $19 a day");
  assert.match(row(l, "Cost")!.sub!, /Mean of 12 priced runs here.*starting now: about \$16/);
  assert.equal(row(l, "Pace")!.v, "All 60 ready in about 11 days");
  assert.match(row(l, "Pace")!.sub!, /17 more wait on you/);
  assert.equal(row(l, "Ships")!.v, "Nothing without you");
  assert.match(row(l, "Also on")!.v, /@quality starts other work/);
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
  assert.match(row(l, "Cost")!.v, /no price measured/);
  assert.equal(row(l, "Lead")!.v, "@quality is paused");
  assert.equal(row(l, "Also on"), undefined);
});
