import { describe, test, expect } from "bun:test";
import { startRelayPoller } from "./authRelay.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fakeResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe("startRelayPoller", () => {
  test("resolves with credentials once the deposit is claimable", async () => {
    let calls = 0;
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls++;
      expect(url).toBe("https://convex.example.com/cli/claim-auth");
      expect(JSON.parse(init.body as string)).toEqual({ nonce: "n0nce" });
      // First poll: nothing deposited yet; second poll: claimed.
      return calls < 2
        ? fakeResponse({ pending: true })
        : fakeResponse({ user_id: "users:1", auth_token: "tok" });
    };

    const poller = startRelayPoller("https://convex.example.com", "n0nce", {
      intervalMs: 5,
      fetchImpl: fetchImpl as any,
    });
    const result = await poller.promise;
    poller.stop();

    expect(calls).toBe(2);
    expect(result).toEqual({ userId: "users:1", apiToken: "tok", nonce: "n0nce" });
  });

  test("keeps polling through transport errors and non-ok responses", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      if (calls === 2) return fakeResponse({ error: "Internal error" }, false);
      return fakeResponse({ user_id: "users:1", auth_token: "tok" });
    };

    const poller = startRelayPoller("https://x", "n", { intervalMs: 5, fetchImpl: fetchImpl as any });
    const result = await poller.promise;
    poller.stop();

    expect(calls).toBe(3);
    expect(result.apiToken).toBe("tok");
  });

  test("stop() ends the loop without resolving", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return fakeResponse({ pending: true });
    };

    const poller = startRelayPoller("https://x", "n", { intervalMs: 5, fetchImpl: fetchImpl as any });
    await sleep(12);
    poller.stop();
    const callsAtStop = calls;
    await sleep(25);

    // At most one in-flight poll after stop; no new ones start.
    expect(calls).toBeLessThanOrEqual(callsAtStop + 1);

    const winner = await Promise.race([poller.promise.then(() => "resolved"), sleep(20).then(() => "pending")]);
    expect(winner).toBe("pending");
  });
});
