// Tier 1: the session circuit breaker is reason-aware. A transient failure (a
// resume we just launched died, a slow/raced cold boot) must clear quickly so a
// recoverable hiccup can't masquerade as a dead session for minutes; a fatal
// failure (no conversation, retired model) keeps the long cooldown.
//
// Imports daemon.ts directly (not the committed daemon.js bundle, which is a stale
// shadow) so we exercise the source the live daemon actually runs.
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  isSessionCircuitOpen,
  recordSessionDeliveryFailure,
  resetSessionDeliveryFailures,
} from "./daemon.ts";

const SID = "circuit-breaker-test-session";
const realNow = Date.now;
let clock = 1_000_000;

beforeEach(() => {
  clock = 1_000_000;
  Date.now = () => clock;
  resetSessionDeliveryFailures(SID);
});
afterEach(() => {
  Date.now = realNow;
  resetSessionDeliveryFailures(SID);
});

const fail = (transient: boolean, n = 1) => {
  for (let i = 0; i < n; i++) recordSessionDeliveryFailure(SID, { transient });
};

test("breaker stays closed below the failure threshold", () => {
  expect(isSessionCircuitOpen(SID)).toBe(false);
  fail(true, 2); // 2 < threshold(3)
  expect(isSessionCircuitOpen(SID)).toBe(false);
});

test("transient failures open the breaker, then clear after the short (15s) cooldown", () => {
  fail(true, 3);
  expect(isSessionCircuitOpen(SID)).toBe(true); // tripped, within cooldown
  clock += 14_000;
  expect(isSessionCircuitOpen(SID)).toBe(true); // still inside 15s
  clock += 2_000; // now 16s > 15s
  expect(isSessionCircuitOpen(SID)).toBe(false); // cleared — this is the fix
});

test("fatal failures hold the breaker open through the transient window (full 5 min)", () => {
  fail(false, 3);
  expect(isSessionCircuitOpen(SID)).toBe(true);
  clock += 16_000; // past the transient cooldown...
  expect(isSessionCircuitOpen(SID)).toBe(true); // ...but a fatal stays locked
  clock += 300_000; // past the 5-min fatal cooldown
  expect(isSessionCircuitOpen(SID)).toBe(false);
});

test("most-recent failure severity wins: fatal×2 then transient -> short cooldown", () => {
  fail(false, 2);
  fail(true, 1);
  expect(isSessionCircuitOpen(SID)).toBe(true);
  clock += 16_000;
  expect(isSessionCircuitOpen(SID)).toBe(false); // last failure was transient
});

test("most-recent failure severity wins: transient×2 then fatal -> long cooldown", () => {
  fail(true, 2);
  fail(false, 1);
  expect(isSessionCircuitOpen(SID)).toBe(true);
  clock += 16_000;
  expect(isSessionCircuitOpen(SID)).toBe(true); // last failure was fatal — still open
});

test("default (no opts) is fatal — backward compatible with the original 5-min behavior", () => {
  recordSessionDeliveryFailure(SID);
  recordSessionDeliveryFailure(SID);
  recordSessionDeliveryFailure(SID);
  expect(isSessionCircuitOpen(SID)).toBe(true);
  clock += 16_000;
  expect(isSessionCircuitOpen(SID)).toBe(true); // not transient -> long cooldown
});

test("a fresh failure after cooldown re-arms the breaker (count resets)", () => {
  fail(true, 3);
  clock += 16_000;
  expect(isSessionCircuitOpen(SID)).toBe(false); // cleared + entry deleted
  fail(true, 2); // count starts from 0 again
  expect(isSessionCircuitOpen(SID)).toBe(false); // 2 < threshold
});
