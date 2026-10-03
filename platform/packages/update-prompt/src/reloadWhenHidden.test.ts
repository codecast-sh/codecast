import { describe, expect, it } from "bun:test";
import { createReloadWhenHidden } from "./reloadWhenHidden";

// Regression for "the palette popup blinks": the service worker's autoUpdate
// flow reloaded every open window the instant a deployed worker activated,
// yanking visible windows (and the compose draft) out from under the user.
// The deferred reload must fire only while the window is hidden.
function fakeDoc(hidden: boolean) {
  const listeners = new Set<() => void>();
  return {
    hidden,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    // Test driver: flip visibility and notify, like the browser would.
    setHidden(h: boolean) {
      this.hidden = h;
      for (const cb of [...listeners]) cb();
    },
    listenerCount: () => listeners.size,
  };
}

describe("createReloadWhenHidden", () => {
  it("reloads immediately when the window is already hidden", () => {
    const doc = fakeDoc(true);
    let reloads = 0;
    createReloadWhenHidden(() => reloads++, doc)();
    expect(reloads).toBe(1);
    expect(doc.listenerCount()).toBe(0);
  });

  it("defers while visible, fires once on the next hide", () => {
    const doc = fakeDoc(false);
    let reloads = 0;
    createReloadWhenHidden(() => reloads++, doc)();
    expect(reloads).toBe(0);

    doc.setHidden(true);
    expect(reloads).toBe(1);
    expect(doc.listenerCount()).toBe(0);
  });

  it("ignores visibility changes that are not a hide", () => {
    const doc = fakeDoc(false);
    let reloads = 0;
    createReloadWhenHidden(() => reloads++, doc)();

    doc.setHidden(false);
    expect(reloads).toBe(0);
    doc.setHidden(true);
    expect(reloads).toBe(1);
  });

  it("stacked activations while visible arm a single reload", () => {
    const doc = fakeDoc(false);
    let reloads = 0;
    const onNeedReload = createReloadWhenHidden(() => reloads++, doc);
    onNeedReload();
    onNeedReload();
    onNeedReload();
    expect(doc.listenerCount()).toBe(1);

    doc.setHidden(true);
    expect(reloads).toBe(1);
  });
});
