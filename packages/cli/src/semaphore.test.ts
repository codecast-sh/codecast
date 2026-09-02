import { expect, test } from "bun:test";
import { countingSemaphore } from "./semaphore.js";

test("run holds at most `limit` slots and releases on throw", async () => {
  const sem = countingSemaphore(2);
  let active = 0;
  let peak = 0;
  const job = async (fail = false) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (fail) throw new Error("boom");
    return active;
  };
  const results = await Promise.allSettled([sem.run(job), sem.run(() => job(true)), sem.run(job), sem.run(job), sem.run(job)]);
  expect(peak).toBe(2);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
  // Every slot came back: two more jobs run at once again.
  peak = 0;
  await Promise.all([sem.run(job), sem.run(job), sem.run(job)]);
  expect(peak).toBe(2);
});
