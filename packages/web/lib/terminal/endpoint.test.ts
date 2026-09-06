import { afterEach, expect, test } from "bun:test";
import { probeEndpoint } from "./endpoint";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const endpoint = { port: 1234, token: "fixture", deviceId: "local", tmux: true };
test("cold snapshot retries a temporary 503 and restores the eventual sessions", async () => {
  let calls = 0;
  const sessions = [{ name: "cast-term-fixture", path: "/tmp", command: "sh", created: 1, attached: 0 }];
  globalThis.fetch = (async () => ++calls < 3 ? Response.json({ unavailable: true }, { status: 503 }) : Response.json({ sessions, tmux: true })) as typeof fetch;
  expect(await probeEndpoint(endpoint, 1200)).toEqual(sessions); expect(calls).toBe(3);
});
test("expired snapshot remains unavailable instead of proving an empty session list", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ unavailable: true }, { status: 503 }); }) as typeof fetch;
  expect(await probeEndpoint(endpoint, 100)).toBeNull(); expect(calls).toBe(1);
});
test("permanent refusal and ordinary 503 are not retried", async () => {
  for (const status of [403, 503]) {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ error: "refused" }, { status }); }) as typeof fetch;
    expect(await probeEndpoint(endpoint)).toBeNull(); expect(calls).toBe(1);
  }
});
