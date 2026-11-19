import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

// The desktop pins document.visibilityState at "visible" (background
// throttling is off); the shell's `shown` is the truth, and the page must
// report it and announce changes like a browser does.
describe("applyShellVisibility", () => {
  let dom: JSDOM;
  const saved: Record<string, unknown> = {};
  beforeAll(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
    for (const k of ["document", "Document", "Event"]) { saved[k] = (globalThis as any)[k]; (globalThis as any)[k] = (dom.window as any)[k]; }
  });
  afterAll(() => {
    for (const k of Object.keys(saved)) (globalThis as any)[k] = saved[k];
    dom.window.close();
  });

  test("a window the shell hides reads hidden, and comes back visible, with one event each way", async () => {
    const { applyShellVisibility } = await import("../windowRole");
    const events: string[] = [];
    document.addEventListener("visibilitychange", () => events.push(document.visibilityState));
    expect(document.visibilityState).toBe("visible");
    applyShellVisibility(null);
    expect(events).toEqual([]);
    applyShellVisibility(false);
    expect(document.visibilityState).toBe("hidden");
    expect(document.hidden).toBe(true);
    applyShellVisibility(false);
    applyShellVisibility(true);
    expect(document.visibilityState).toBe("visible");
    expect(document.hidden).toBe(false);
    expect(events).toEqual(["hidden", "visible"]);
  });
});
