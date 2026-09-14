import { beforeEach, describe, expect, it } from "bun:test";
import { browserPaneRecents, clearBrowserPaneRecents, rememberBrowserPaneUrl } from "../browserPaneRecents";

const KEY = "codecast.browserPaneRecents";

function installStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const fake = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
  return map;
}

describe("browserPaneRecents", () => {
  beforeEach(() => installStorage());

  it("is empty before anything opened", () => {
    expect(browserPaneRecents()).toEqual([]);
  });

  it("puts the newest page first", () => {
    rememberBrowserPaneUrl("http://localhost:3000/");
    rememberBrowserPaneUrl("http://localhost:5173/");
    expect(browserPaneRecents()).toEqual(["http://localhost:5173/", "http://localhost:3000/"]);
  });

  it("moves a page back to the front instead of doubling it", () => {
    rememberBrowserPaneUrl("http://a/");
    rememberBrowserPaneUrl("http://b/");
    rememberBrowserPaneUrl("http://a/");
    expect(browserPaneRecents()).toEqual(["http://a/", "http://b/"]);
  });

  it("keeps eight", () => {
    for (let i = 0; i < 12; i += 1) rememberBrowserPaneUrl(`http://localhost:${3000 + i}/`);
    const recents = browserPaneRecents();
    expect(recents.length).toBe(8);
    expect(recents[0]).toBe("http://localhost:3011/");
    expect(recents[7]).toBe("http://localhost:3004/");
  });

  it("reads a corrupt or foreign value as empty", () => {
    installStorage({ [KEY]: "not json" });
    expect(browserPaneRecents()).toEqual([]);
    installStorage({ [KEY]: JSON.stringify({ url: "x" }) });
    expect(browserPaneRecents()).toEqual([]);
    installStorage({ [KEY]: JSON.stringify(["http://a/", 7, null, "http://b/"]) });
    expect(browserPaneRecents()).toEqual(["http://a/", "http://b/"]);
  });

  it("survives a storage that refuses to answer", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => { throw new Error("denied"); },
        setItem: () => { throw new Error("denied"); },
        removeItem: () => { throw new Error("denied"); },
      },
      configurable: true,
      writable: true,
    });
    expect(browserPaneRecents()).toEqual([]);
    expect(() => rememberBrowserPaneUrl("http://localhost:3000/")).not.toThrow();
    expect(() => clearBrowserPaneRecents()).not.toThrow();
  });

  it("forgets everything on demand", () => {
    rememberBrowserPaneUrl("http://localhost:3000/");
    clearBrowserPaneRecents();
    expect(browserPaneRecents()).toEqual([]);
  });
});
