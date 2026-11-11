import { expect, test } from "bun:test";
import { start } from "./localSdk";

test("a burst of publishes goes out one write at a time, in order", async () => {
  let inFlight = 0;
  let most = 0;
  const keys: string[] = [];
  (globalThis as any).postMessage = () => {};
  globalThis.fetch = (async (_url: string, init: any) => {
    inFlight++;
    most = Math.max(most, inFlight);
    keys.push(JSON.parse(init.body).key);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return new Response("{}", { status: 200 });
  }) as any;
  start((on) => on("local.start", ($: any) => { for (let i = 0; i < 10; i++) $.publish(`k${i}`, i); }));
  await (globalThis as any).onmessage({ data: { type: "init", name: "m", manifest: {}, siteUrl: "https://x.site", apiToken: "t", deviceName: "d", castBin: "cast" } });
  await new Promise((r) => setTimeout(r, 1300));
  expect(keys).toEqual(Array.from({ length: 10 }, (_, i) => `k${i}`));
  expect(most).toBe(1);
});

test("a local.call hook is told who made the call", async () => {
  const posted: any[] = [];
  (globalThis as any).postMessage = (m: any) => posted.push(m);
  start((on) => on("local.call", { method: "whoami" }, (_$: any, e: any) => ({ caller: e.caller, args: e.args })));
  await (globalThis as any).onmessage({ data: { type: "init", name: "m", manifest: {}, siteUrl: "https://x.site", apiToken: "t", deviceName: "d", castBin: "cast" } });
  const caller = { id: "u_ben", name: "Ben", is_author: false };
  await (globalThis as any).onmessage({ data: { type: "call", id: "c1", method: "whoami", args: { a: 1 }, caller } });
  expect(posted.find((m) => m.type === "result")).toEqual({ type: "result", id: "c1", result: { caller, args: { a: 1 } } });
});
