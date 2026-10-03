import { describe, expect, it } from "bun:test";
import { serviceWorkerHooks, UPDATE_POLL_MS } from "./serviceWorker";

describe("serviceWorkerHooks", () => {
  it("polls a registered worker for updates and swallows a failed check", async () => {
    const ticks: { fn: () => void; ms: number }[] = [];
    let checks = 0;
    const hooks = serviceWorkerHooks(() => {}, { reloadWhenAway: () => {}, every: (fn, ms) => ticks.push({ fn, ms }) });
    hooks.onRegisteredSW("/sw.js", undefined);
    expect(ticks).toHaveLength(0);
    hooks.onRegisteredSW("/sw.js", { update: async () => { checks++; throw new Error("offline"); } });
    expect(ticks.map((t) => t.ms)).toEqual([UPDATE_POLL_MS]);
    ticks[0]!.fn();
    await Promise.resolve();
    expect(checks).toBe(1);
  });

  it("defers the reload and notes the waiting update on every activation", () => {
    const calls: string[] = [];
    const hooks = serviceWorkerHooks(() => calls.push("waiting"), { reloadWhenAway: () => calls.push("reload-when-away") });
    hooks.onNeedReload();
    hooks.onNeedReload();
    expect(calls).toEqual(["reload-when-away", "waiting", "reload-when-away", "waiting"]);
  });
});
