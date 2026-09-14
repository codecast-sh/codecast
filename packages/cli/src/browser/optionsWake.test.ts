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
  const context = vm.createContext({
    URLSearchParams, location,
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
  return { removed, messages, timers };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("extension wake page", () => {
  test("a worker that never answers cannot leave the settings tab open", async () => {
    const page = optionsPage("#wake", "silent");
    await settle();
    expect(page.removed).toEqual([]);
    const [timer] = page.timers.values();
    expect(timer.ms).toBe(3000);
    timer.fn();
    await settle();
    expect(page.removed).toEqual([7]);
    expect(page.timers.size).toBe(0);
  });

  test.each(["missing", "connected"] as const)("the wake page closes its own tab when the worker is %s", async (response) => {
    const page = optionsPage("#wake", response);
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
