/**
 * The machine-wide limits behind launching Chrome and waking the extension:
 * every session's verbs walk the same ladder, and a dead worker must not
 * mean one wake tab per session per command.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../../test-helpers/codecastDir.js";
import { takeStamp, takeWake, WAKE_ONCE_MS } from "./realChrome.js";

let isolation: IsolatedCodecastDir;
beforeEach(() => {
  isolation = isolateCodecastDir("real-chrome-test-");
});
afterEach(() => {
  isolation.restore();
});

test("one wake per outage: the same outage never gets a second, a reconnect opens the next", () => {
  const t0 = 1_000_000;
  expect(takeWake("seen:100", t0)).toBe(true);
  // Same outage, any time later: no.
  expect(takeWake("seen:100", t0 + 1_000)).toBe(false);
  expect(takeWake("seen:100", t0 + 3 * WAKE_ONCE_MS)).toBe(false);
  // A new outage (the extension reconnected in between, then dropped again),
  // but within the race window of the last wake: not yet.
  expect(takeWake("seen:200", t0 + WAKE_ONCE_MS - 1)).toBe(false);
  expect(takeWake("seen:200", t0 + 3 * WAKE_ONCE_MS)).toBe(true);
  expect(takeWake("seen:200", t0 + 4 * WAKE_ONCE_MS)).toBe(false);
});

test("a wake stamp written ahead of now is a hold (the manual kill switch)", () => {
  const t0 = 1_000_000;
  expect(takeWake("seen:1", t0 + 10 * WAKE_ONCE_MS)).toBe(true);
  expect(takeWake("seen:2", t0)).toBe(false);
});

test("a launch is taken once per window", () => {
  const t0 = 1_000_000;
  expect(takeStamp("launchedAt", 60_000, t0)).toBe(true);
  expect(takeStamp("launchedAt", 60_000, t0 + 59_999)).toBe(false);
  expect(takeStamp("launchedAt", 60_000, t0 + 60_000)).toBe(true);
});
