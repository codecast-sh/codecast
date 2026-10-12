import assert from "node:assert/strict";
import { test } from "bun:test";
import { lineStartLedger } from "../lineStartLedger";
import type { LineAdmission } from "../../../lib/lineFlow";

const OFF: LineAdmission = { role: { id: "r1", handle: "quality", paused: false }, on: false, queued: 60, slots: 5, busy: 0, hands: 0, handsCap: 6 };
const fig = (l: ReturnType<typeof lineStartLedger>, label: string) => l.figures.find((f) => f.label === label)?.value;
const row = (l: ReturnType<typeof lineStartLedger>, k: string) => l.rows.find((r) => r.k === k);

test("77 waiting, 60 ready, 5 places, 6 a day: the review says how many start, the pace, the worst case and what else turns on", () => {
  const l = lineStartLedger({ project: "Agent Quality", admission: { ...OFF, hands: 1 }, waiting: 77, ready: 60, notReady: [{ count: 17, words: "a fix to decide" }], cost: { avgUsd: 3.2, runs: 12, scope: "project" }, roleOwnSwitchOff: true });
  assert.equal(fig(l, "sessions start now"), "5");
  assert.equal(l.figures[0].sub, "of 77 waiting");
  assert.equal(fig(l, "sessions a day, the cap"), "6");
  assert.equal(l.figures[1].sub, "1 used today · one total for @quality");
  assert.equal(fig(l, "a month at the cap"), "~$576");
  assert.equal(l.figures[2].sub, "~$19 a day");
  assert.equal(l.figures[2].flag, "no dollar cap");
  assert.equal(row(l, "Price")!.v, "About $3 a session, from 12 past runs here");
  assert.equal(row(l, "Pace")!.v, "All 60 ready in about 11 days, 5 at once; 17 more wait on you first");
  assert.match(row(l, "Merges")!.v, /Nothing without you/);
  assert.match(l.lead!.v, /Also lets @quality answer its sessions' questions for you in Agent Quality/);
  assert.match(row(l, "Does")!.v, /Agent Quality's repo/);
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
  assert.equal(fig(l, "a month, not priced yet"), "$?");
  assert.match(row(l, "Price")!.v, /Unknown: no run has recorded a cost/);
  assert.match(row(l, "Lead")!.v, /^@quality is paused/);
  assert.equal(l.lead, undefined);
});

test("a price borrowed from other projects says so, and large figures read with a separator", () => {
  const l = lineStartLedger({ project: "Broker Outreach", admission: { ...OFF, queued: 2 }, waiting: 2, ready: 2, cost: { avgUsd: 6.99, runs: 5, scope: "workspace" } });
  assert.equal(fig(l, "sessions start now"), "2");
  assert.equal(l.figures[0].sub, undefined, "everything waiting starts: no second count");
  assert.equal(fig(l, "a month at the cap"), "~$1,258");
  assert.equal(row(l, "Price")!.v, "About $7 a session, from 5 past runs on other projects");
});
