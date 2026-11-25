// A live reply must never delay message sync: its push skips the throttle,
// sends nothing while the deployment's write budget has paused bulk sync, and
// a refusal of its own does not start that pause.

import { describe, expect, test } from "bun:test";
import { SyncService } from "./syncService.js";

const ARGS = { conversation_id: "c1", message_id: "m1", seq: 1, started_at: 1, text: "Hello" };
const BUDGET = () => new Error("[CONVEX M(replyStreams:push)] Server Error\nToo many writes per second");

function service(mutation: (name: string, args: unknown) => Promise<unknown>) {
  const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
  const calls: string[] = [];
  (sync as any).client = { mutation: (name: string, args: unknown) => (calls.push(name), mutation(name, args)) };
  const paused = () => (sync as any).writeBudget.waitMs() as number;
  return { sync, calls, paused };
}

describe("SyncService.pushReplyStream", () => {
  test("sends the push with the api token and returns the server's answer", async () => {
    let sent: unknown;
    const s = service(async (_n, args) => ((sent = structuredClone(args)), { state: "written" }));
    expect(await s.sync.pushReplyStream(ARGS)).toEqual({ state: "written" });
    expect(s.calls).toEqual(["replyStreams:push"]);
    expect(sent).toEqual({ api_token: "t", ...ARGS });
  });

  test("a write-budget refusal of the push answers null and does not pause message sync", async () => {
    const s = service(async () => { throw BUDGET(); });
    expect(await s.sync.pushReplyStream(ARGS)).toBeNull();
    expect(s.paused()).toBe(0);
  });

  test("the same refusal of any other write does pause it, which is what the push is spared", async () => {
    const s = service(async () => { throw BUDGET(); });
    await s.sync.recordPeerLink({ from_device_id: "a", to_device_id: "b", mode: "direct", ok: true }).catch(() => {});
    expect(s.paused()).toBeGreaterThan(0);
  });

  test("while message sync is paused, the push sends nothing", async () => {
    const s = service(async () => { throw BUDGET(); });
    await s.sync.recordPeerLink({ from_device_id: "a", to_device_id: "b", mode: "direct", ok: true }).catch(() => {});
    s.calls.length = 0;
    expect(await s.sync.pushReplyStream(ARGS)).toBeNull();
    expect(s.calls).toEqual([]);
  });

  test("any other failure rejects, so the tracker can log why", async () => {
    const s = service(async () => { throw new Error("Could not find public function for 'replyStreams:push'"); });
    await expect(s.sync.pushReplyStream(ARGS)).rejects.toThrow("Could not find public function");
    expect(s.paused()).toBe(0);
  });
});
