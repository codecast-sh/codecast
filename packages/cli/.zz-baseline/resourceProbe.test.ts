import { expect, test } from "bun:test";
import { createResourceProbeGate } from "./resourceProbe";

test("a stuck probe has a caller deadline and cannot accumulate duplicate children", async () => {
  const probe = createResourceProbeGate();
  let release!: (value: number) => void;
  let starts = 0;
  const run = () => { starts++; return new Promise<number>(resolve => { release = resolve; }); };
  expect(await probe("ps", run, 5)).toBeUndefined();
  expect(await probe("ps", run, 5)).toBeUndefined();
  expect(starts).toBe(1);
  release(42);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await probe("ps", async () => 99, 100)).toBe(99);
});

test("failed probes clear their slot and independent probes still work", async () => {
  const probe = createResourceProbeGate();
  expect(await probe("ps", () => Promise.reject(new Error("unavailable")), 100)).toBeUndefined();
  expect(await probe("ps", async () => 1, 100)).toBe(1);
  expect(await probe("memory", async () => 2, 100)).toBe(2);
});
