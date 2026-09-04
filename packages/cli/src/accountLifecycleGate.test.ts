import { expect, test } from "bun:test";
import { AccountLifecycleGate } from "./accountLifecycleGate";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("a switch cannot change credentials while Claude is reading them and starting", async () => {
  const gate = new AccountLifecycleGate();
  const ready = deferred();
  const started = deferred();
  const events: string[] = [];
  let account = "old";
  const launch = gate.resume("claude", async () => {
    events.push(`read:${account}`);
    started.resolve();
    await ready.promise;
    events.push(`ready:${account}`);
  });
  await started.promise;
  const change = gate.acquireSwitch().then((release) => {
    account = "new";
    events.push("switched");
    release();
  });
  expect(events).toEqual(["read:old"]);
  ready.resolve();
  await Promise.all([launch, change]);
  expect(events).toEqual(["read:old", "ready:old", "switched"]);
});

test("queued account switches settle before a waiting resume reads the login", async () => {
  const gate = new AccountLifecycleGate();
  const first = await gate.acquireSwitch();
  let account = "first";
  const second = gate.acquireSwitch().then((release) => { account = "second"; release(); });
  const launch = gate.resume("claude", async () => account);
  const codex = gate.resume("codex", async () => "codex ready");
  expect(await codex).toBe("codex ready");
  first();
  await second;
  expect(await launch).toBe("second");
});

test("independent Claude resumes remain concurrent and a failed boot releases its hold", async () => {
  const gate = new AccountLifecycleGate();
  const ready = deferred();
  const first = gate.resume("claude", async () => { await ready.promise; return "first"; });
  expect(await gate.resume("claude", async () => "second")).toBe("second");
  await expect(gate.resume(undefined, async () => { throw new Error("boot failed"); })).rejects.toThrow("boot failed");
  ready.resolve();
  expect(await first).toBe("first");
  const release = await gate.acquireSwitch();
  release();
  release();
  expect(await gate.resume("claude", async () => "recovered")).toBe("recovered");
});
