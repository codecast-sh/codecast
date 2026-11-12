import "./test-helpers/isolatedTmuxServer.js";
import { afterEach, expect, test } from "bun:test";
import { hibernationConcurrencyForTests as h, RESUME_IN_FLIGHT_TIMEOUT_MS } from "./daemon.js";
import { waitFor } from "./test-helpers/messagingHarness.js";

const defer = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const resume = (sessionId: string) => h.autoResumeSession(sessionId, "", {}, undefined, undefined, "claude", { userInitiated: true });
afterEach(() => { h.setResumeInner(null); });

test("a transcript transfer drops the account hold, keeps the in-flight guard fresh, and holds again after", async () => {
  const sessionId = `transfer-${crypto.randomUUID()}`;
  const inside = defer(), finish = defer();
  let touch!: () => void;
  let innerCalls = 0;
  let switchAfter: Promise<() => void> | undefined;
  let switched = false;
  h.setResumeInner(async (_s, _c, _t, _cwd, _conv, _a, o) => {
    innerCalls++;
    const out = await o!.duringTransfer!(async (t) => { touch = t; inside.resolve(); await finish.promise; return "fetched"; });
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
    touch();
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
