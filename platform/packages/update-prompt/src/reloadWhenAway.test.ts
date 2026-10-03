import { describe, expect, it } from "bun:test";
import { createReloadWhenAway, IDLE_RELOAD_MS } from "./reloadWhenAway";

// Regression for "the palette popup blinks": the service worker's autoUpdate
// flow reloaded every open window the instant a deployed worker activated,
// yanking visible windows (and the compose draft) out from under the user.
// The deferred reload must fire only while the window is hidden or untouched.
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

// A window with no input events and a clock the test drives.
function fakeIdle() {
  const listeners = new Map<string, Set<() => void>>();
  const timers: { fn: () => void; at: number }[] = [];
  let t = 0;
  return {
    opts: (busy: () => boolean = () => false) => ({
      busy,
      now: () => t,
      after: (fn: () => void, ms: number) => timers.push({ fn, at: t + ms }),
      input: {
        addEventListener: (type: string, cb: () => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(cb); },
        removeEventListener: (type: string, cb: () => void) => { listeners.get(type)?.delete(cb); },
      },
    }),
    touch(type = "keydown") { for (const cb of [...(listeners.get(type) ?? [])]) cb(); },
    // Advance the clock, running each timer that comes due in order.
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        t = due.at;
        due.fn();
      }
      t = end;
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

describe("createReloadWhenAway", () => {
  it("reloads immediately when the window is already hidden", () => {
    const doc = fakeDoc(true);
    let reloads = 0;
    createReloadWhenAway(() => reloads++, doc, fakeIdle().opts())();
    expect(reloads).toBe(1);
    expect(doc.listenerCount()).toBe(0);
  });

  it("defers while visible, fires once on the next hide", () => {
    const doc = fakeDoc(false);
    let reloads = 0;
    createReloadWhenAway(() => reloads++, doc, fakeIdle().opts())();
    expect(reloads).toBe(0);

    doc.setHidden(true);
    expect(reloads).toBe(1);
    expect(doc.listenerCount()).toBe(0);
  });

  it("ignores visibility changes that are not a hide", () => {
    const doc = fakeDoc(false);
    let reloads = 0;
    createReloadWhenAway(() => reloads++, doc, fakeIdle().opts())();

    doc.setHidden(false);
    expect(reloads).toBe(0);
    doc.setHidden(true);
    expect(reloads).toBe(1);
  });

  it("stacked activations while visible arm a single reload", () => {
    const doc = fakeDoc(false);
    let reloads = 0;
    const onNeedReload = createReloadWhenAway(() => reloads++, doc, fakeIdle().opts());
    onNeedReload();
    onNeedReload();
    onNeedReload();
    expect(doc.listenerCount()).toBe(1);

    doc.setHidden(true);
    expect(reloads).toBe(1);
  });

  // Regression for "the fix shipped and my window still shows the old
  // behaviour": a desktop main window never hides, so the hide leg alone left
  // it on the old bundle for a day.
  it("reloads a visible window once it has gone untouched for the idle window", () => {
    const doc = fakeDoc(false);
    const idle = fakeIdle();
    let reloads = 0;
    createReloadWhenAway(() => reloads++, doc, idle.opts())();

    idle.advance(IDLE_RELOAD_MS - 1);
    expect(reloads).toBe(0);
    idle.advance(1);
    expect(reloads).toBe(1);
    expect(doc.listenerCount()).toBe(0);
    expect(idle.listenerCount()).toBe(0);
  });

  it("input pushes the idle reload out by a full idle window", () => {
    const doc = fakeDoc(false);
    const idle = fakeIdle();
    let reloads = 0;
    createReloadWhenAway(() => reloads++, doc, idle.opts())();

    idle.advance(IDLE_RELOAD_MS - 1000);
    idle.touch("pointermove");
    idle.advance(IDLE_RELOAD_MS - 1);
    expect(reloads).toBe(0);
    idle.advance(1);
    expect(reloads).toBe(1);
  });

  it("a busy window waits out the idle reload, and still reloads on a hide", () => {
    const doc = fakeDoc(false);
    const idle = fakeIdle();
    let reloads = 0;
    let inCall = true;
    createReloadWhenAway(() => reloads++, doc, idle.opts(() => inCall))();

    idle.advance(IDLE_RELOAD_MS * 3);
    expect(reloads).toBe(0);
    inCall = false;
    idle.advance(IDLE_RELOAD_MS);
    expect(reloads).toBe(1);

    const other = fakeDoc(false);
    let hides = 0;
    createReloadWhenAway(() => hides++, other, fakeIdle().opts(() => true))();
    other.setHidden(true);
    expect(hides).toBe(1);
  });

  it("reloads once when a hide and the idle window both come due", () => {
    const doc = fakeDoc(false);
    const idle = fakeIdle();
    let reloads = 0;
    createReloadWhenAway(() => reloads++, doc, idle.opts())();
    doc.setHidden(true);
    idle.advance(IDLE_RELOAD_MS * 2);
    expect(reloads).toBe(1);
  });
});
