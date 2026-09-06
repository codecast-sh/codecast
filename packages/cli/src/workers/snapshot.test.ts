import { expect, test } from "bun:test";
import { ReadSnapshot } from "./snapshot.js";
test("cold cache returns unavailable immediately, one refresh is shared and stale failures never imply gone", async () => {
  let now = 1000; let calls = 0; let finish!: (v: string[]) => void;
  const snapshot = new ReadSnapshot(() => { calls++; return new Promise<string[]>(resolve => { finish = resolve; }); }, 5000, 1000, () => now);
  expect(snapshot.get()).toBeNull(); expect(snapshot.get()).toBeNull(); expect(calls).toBe(1);
  finish(["session"]); await snapshot.refresh(); expect(snapshot.get()?.data).toEqual(["session"]);
  now += 1500; expect(snapshot.get()?.data).toEqual(["session"]); expect(calls).toBe(2);
  now += 5001; expect(snapshot.get()).toBeNull();
  snapshot.invalidate(); finish([]); await snapshot.refresh(); expect(snapshot.get()).toBeNull(); expect(calls).toBe(3);
  finish(["new"]); await snapshot.refresh(); expect(snapshot.get()?.data).toEqual(["new"]);
});
test("read rejection retains good data only inside its age limit", async () => {
  let fail = false; let now = 1;
  const snapshot = new ReadSnapshot(async () => { if (fail) throw new Error("timeout"); return ["still alive"]; }, 5000, 1000, () => now);
  await snapshot.refresh(); fail = true; now = 2000; await snapshot.refresh(); expect(snapshot.get()?.data).toEqual(["still alive"]);
  now = 6000; await snapshot.refresh(); expect(snapshot.get()).toBeNull();
});
