import { expect, test } from "bun:test";
import { msUntilInputQuiet, noteInputForTests, TYPING_QUIET_MS, whenInputQuiet } from "../inputQuiet";

// Background bulk work (an inbox apply, a coarse clock tick) waits for a pause
// in typing, and never longer than its cap.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("runs at once when nobody has typed", () => {
  let ran = 0;
  whenInputQuiet(() => { ran++; }, 1000);
  expect(ran).toBe(1);
});

test("waits for the pause after the last key", async () => {
  noteInputForTests();
  expect(msUntilInputQuiet(TYPING_QUIET_MS)).toBeGreaterThan(0);
  let ranAt = 0;
  const start = Date.now();
  whenInputQuiet(() => { ranAt = Date.now(); }, 5000);
  expect(ranAt).toBe(0);
  await sleep(TYPING_QUIET_MS + 150);
  expect(ranAt).toBeGreaterThanOrEqual(start + TYPING_QUIET_MS - 5);
});

test("gives up waiting at its cap while keys keep coming", async () => {
  noteInputForTests();
  const typing = setInterval(noteInputForTests, 50);
  let ran = false;
  whenInputQuiet(() => { ran = true; }, 300);
  await sleep(700);
  clearInterval(typing);
  expect(ran).toBe(true);
});

test("a cancelled wait never runs", async () => {
  noteInputForTests();
  let ran = false;
  const cancel = whenInputQuiet(() => { ran = true; }, 5000);
  cancel();
  await sleep(TYPING_QUIET_MS + 150);
  expect(ran).toBe(false);
});
