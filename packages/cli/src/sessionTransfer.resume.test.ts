import "./test-helpers/isolatedTmuxServer.js";
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { hibernationConcurrencyForTests as h, RESUME_IN_FLIGHT_TIMEOUT_MS, resumeOrRepair } from "./daemon.js";
import { waitFor } from "./test-helpers/messagingHarness.js";

const defer = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const resume = (sessionId: string) => h.autoResumeSession(sessionId, "", {}, undefined, undefined, "claude", { userInitiated: true });
afterEach(() => { h.setResumeInner(null); h.setTransferTouchMs(5_000); });

test("a transcript transfer drops the account hold, keeps the in-flight guard fresh without any reports, and holds again after", async () => {
  h.setTransferTouchMs(10);
  const sessionId = `transfer-${crypto.randomUUID()}`;
  const inside = defer(), finish = defer();
  let innerCalls = 0;
  let switchAfter: Promise<() => void> | undefined;
  let switched = false;
  h.setResumeInner(async (_s, _c, _t, _cwd, _conv, _a, o) => {
    innerCalls++;
    const out = await o!.duringTransfer!(async () => { inside.resolve(); await finish.promise; return "fetched"; });
    switchAfter = h.accountLifecycleGate.acquireSwitch().then((release) => { switched = true; return release; });
    await new Promise((r) => setTimeout(r, 20));
    expect(switched).toBe(false);
    return out === "fetched";
  });
  const first = resume(sessionId);
  try {
    await inside.promise;
    let got = false;
    const release = h.accountLifecycleGate.acquireSwitch().then((r) => { got = true; return r; });
    await waitFor(() => got, { timeoutMs: 1000 });
    (await release)();
    h.resumeInFlightStarted.set(sessionId, Date.now() - RESUME_IN_FLIGHT_TIMEOUT_MS - 1);
    await waitFor(() => Date.now() - (h.resumeInFlightStarted.get(sessionId) ?? 0) < 1000, { timeoutMs: 1000 });
    const second = resume(sessionId);
    await new Promise((r) => setTimeout(r, 20));
    expect(innerCalls).toBe(1);
    finish.resolve();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    (await switchAfter!)();
    expect(switched).toBe(true);
  } finally { finish.resolve(); await first; }
});

test("a resume that another one replaced during its transfer stops there", async () => {
  const sessionId = `transfer-${crypto.randomUUID()}`;
  let outcome: unknown;
  h.setResumeInner(async (_s, _c, _t, _cwd, _conv, _a, o) => {
    outcome = await o!.duringTransfer!(async () => {
      h.resumeInFlight.delete(sessionId);
      h.resumeInFlightStarted.delete(sessionId);
      return "fetched";
    });
    return outcome !== "superseded";
  });
  expect(await resume(sessionId)).toBe(false);
  expect(outcome).toBe("superseded");
});

test("a cancelled transcript transfer is neither repaired nor rebuilt; any other failure is", async () => {
  const sessionId = `transfer-${crypto.randomUUID()}`;
  let fetchResult: unknown = "cancelled";
  h.setResumeInner(async (_s, _c, _t, _cwd, _conv, _a, o) => (await o!.duringTransfer!(async () => fetchResult)) === "ok");
  let repairs = 0;
  const repair = async () => { repairs++; return true; };
  expect(await resumeOrRepair(sessionId, () => resume(sessionId), repair)).toBe("cancelled");
  expect(repairs).toBe(0);
  fetchResult = null;
  expect(await resumeOrRepair(sessionId, () => resume(sessionId), repair)).toBe("repaired");
  expect(repairs).toBe(1);
  fetchResult = "ok";
  expect(await resumeOrRepair(sessionId, () => resume(sessionId), repair)).toBe("resumed");
});

test("resume_session and delivery stop on a cancelled transfer before any repair, rebuild or failure count", () => {
  const src = fs.readFileSync(path.join(import.meta.dir, "daemon.ts"), "utf-8");
  const handler = src.slice(src.indexOf('case "resume_session"'), src.indexOf('case "config_list"'));
  const stop = handler.indexOf('if (outcome === "cancelled")');
  expect(stop).toBeGreaterThan(handler.indexOf("resumeOrRepair("));
  expect(handler.slice(stop, handler.indexOf("resumed = outcome !== null"))).toContain("break;");
  expect(handler.slice(stop)).toContain('reason: "transfer_cancelled"');
  expect(handler).not.toMatch(/resumed = await autoResumeSession\(sessionId,/);
  const delivery = src.slice(src.indexOf("const outcome = await resumeOrRepair(\n    sessionId,"));
  const cancelAt = delivery.indexOf('if (outcome === "cancelled")');
  expect(cancelAt).toBeGreaterThan(0);
  expect(delivery.slice(cancelAt, delivery.indexOf("\n  }\n", cancelAt))).toContain("return false;");
  expect(delivery.slice(0, cancelAt)).not.toMatch(/await repairAndResumeSession\(/);
});
