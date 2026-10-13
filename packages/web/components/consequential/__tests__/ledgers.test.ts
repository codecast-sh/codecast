import assert from "node:assert/strict";
import { test } from "bun:test";
import { agentFullAccessLedger, featuresAllLedger, routineActivateLedger } from "../ledgers";
import { ledgerLines, roleOnlineLedger } from "../roleOnline";

test("agent full access names what changes and for which sessions", () => {
  const l = agentFullAccessLedger({ agent: "Codex", label: "Full access", from: "Default", sandbox: false });
  assert.deepEqual(l.shift, ["Default", "Full access"]);
  assert.equal(l.figures.find((f) => f.label === "sandbox")!.value, "No");
  assert.match(l.rows.find((r) => r.k === "Applies to")!.v, /Sessions started after this/);
});

test("turning on a group of features lists every one", () => {
  const l = featuresAllLedger({ group: "Browser", machine: "MacBook", names: ["Browser", "Computer"] });
  assert.equal(l.figures[0].value, "2");
  assert.deepEqual(l.rows[0].list, ["Browser", "Computer"]);
  assert.equal(l.confirm, "Turn on all 2");
});

test("a routine that applies is said to act without asking", () => {
  assert.match(routineActivateLedger({ title: "Ads daily", every: "1d", applies: true }).rows[0].v, /without asking/);
  assert.match(routineActivateLedger({ title: "Ads daily", every: "1d", applies: false }).rows[0].v, /you approve each change/);
});

test("bringing a role online says whether it then starts work unasked, as lines a phone alert can show", () => {
  const on = ledgerLines(roleOnlineLedger({ handle: "growth", name: "Growth lead", host: "Ashot", startsOnItsOwn: true, sessionsPerDay: 6 }));
  assert.ok(on.includes("6 paid sessions a day it may start unasked"));
  assert.ok(on.some((x) => /^To stop:/.test(x)));
  const off = ledgerLines(roleOnlineLedger({ handle: "growth", name: "Growth lead", host: "Ashot", startsOnItsOwn: false, sessionsPerDay: 6 }));
  assert.ok(off.includes("Starts work: Only when you ask: its switch is off"));
});
