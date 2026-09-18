import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../../browser-extension/options.js", import.meta.url), "utf8");

function optionsPage(hash: string, response: "silent" | "missing" | "connected") {
  const removed: number[] = [];
  const messages: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const element = {
    value: "", hidden: false, textContent: "", style: {},
    addEventListener() {}, replaceChildren() {}, appendChild() {},
    querySelector: () => element, classList: { add() {}, remove() {} },
  };
  const location = { hash, pathname: "/options.html" };
  // The page's deadline reads the clock; tests move it.
  let now = 1_000_000;
  const FakeDate = class extends Date { static now() { return now; } };
  const context = vm.createContext({
    URLSearchParams, location, Date: FakeDate,
    history: { replaceState() { location.hash = ""; } },
    document: { getElementById: () => element, createElement: () => element },
    CAST_DEFAULT_PORT: 41729, renderBridgeStatus: () => ({ cls: "state-bad" }),
    readBridgeStatus: async () => ({ state: "dead", attached: [] }),
    chrome: {
      runtime: {
        getManifest: () => ({ version: "0.1.0" }),
        sendMessage: ({ op }: { op: string }) => {
          messages.push(op);
          if (response === "silent") return new Promise(() => {});
          if (response === "missing") return Promise.reject(new Error("Receiving end does not exist"));
          return Promise.resolve({ ok: true });
        },
      },
      storage: { local: { get: async () => ({}) } },
      tabs: {
        getCurrent: async () => ({ id: 7 }),
        remove: async (id: number) => { removed.push(id); },
      },
    },
    setInterval: () => 0,
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  vm.runInContext(source, context);
  /** Fire the oldest pending timer, the way the clock would. */
  const tick = async () => { const [id, t] = [...timers.entries()][0]; timers.delete(id); t.fn(); await settle(); await settle(); };
  return { removed, messages, timers, tick, advance: (ms: number) => { now += ms; } };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("extension wake page", () => {
  test.each(["silent", "missing"] as const)("a worker that is %s is asked again every two seconds while the page stays, then the page closes at the deadline", async (response) => {
    const page = optionsPage("#wake", response);
    await settle();
    expect(page.messages).toEqual(["wake"]);
    expect(page.removed).toEqual([]);
    // A silent worker: the ask's own 2 s clock fires first; a missing one rejected at once. Either way a 2 s pause follows, then the next ask.
    if (response === "silent") await page.tick();
    await page.tick();
    expect(page.messages).toEqual(["wake", "wake"]);
    expect(page.removed).toEqual([]);
    // Past the deadline the loop stops and the page closes its own tab.
    page.advance(180_000);
    if (response === "silent") await page.tick();
    await page.tick();
    expect(page.removed).toEqual([7]);
    expect(page.timers.size).toBe(0);
  });

  test("the wake page closes its own tab as soon as the worker answers", async () => {
    const page = optionsPage("#wake", "connected");
    await settle();
    expect(page.messages).toEqual(["wake"]);
    expect(page.removed).toEqual([7]);
    expect(page.timers.size).toBe(0);
  });

  test("opening settings normally never closes the human's tab", async () => {
    const page = optionsPage("", "missing");
    await settle();
    expect(page.messages).toEqual([]);
    expect(page.removed).toEqual([]);
    expect(page.timers.size).toBe(0);
  });
});
