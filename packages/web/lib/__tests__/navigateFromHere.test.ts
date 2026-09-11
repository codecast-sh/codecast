import { afterEach, describe, expect, it } from "bun:test";
import { isSatelliteWindow, navigateFromHere } from "../desktop";

// A link in a window you STAND in (the voice window's strip, the people
// window) belongs to the main window. The founder clicked Chat on the burst
// strip and the whole app booted inside the strip (2026-09-12): the button
// routed the window it was drawn in. The rule lives in one helper so every
// "open the chat" gesture answers the same way.

const original = (globalThis as any).window;

function shell(flags: Record<string, unknown> | null, sent: string[] = []) {
  (globalThis as any).window =
    flags === null ? {} : { __CODECAST_ELECTRON__: { ...flags, paletteNavigate: (p: string) => sent.push(p) } };
  return sent;
}

afterEach(() => {
  (globalThis as any).window = original;
});

describe("isSatelliteWindow", () => {
  it("is the people window and the call panel, whatever shape it is in", () => {
    shell({ isPeopleWindow: true });
    expect(isSatelliteWindow()).toBe(true);
    shell({ isCallPanelWindow: true });
    expect(isSatelliteWindow()).toBe(true);
  });

  it("is not the main window, a detached tab, or a browser tab", () => {
    shell({});
    expect(isSatelliteWindow()).toBe(false);
    shell({ isTabWindow: true });
    expect(isSatelliteWindow()).toBe(false);
    shell(null);
    expect(isSatelliteWindow()).toBe(false);
  });
});

describe("navigateFromHere", () => {
  it("hands the path to the main window from the voice window and stays put", () => {
    const sent = shell({ isCallPanelWindow: true });
    const here: string[] = [];
    navigateFromHere("/chat/abc", (p) => here.push(p));
    expect(sent).toEqual(["/chat/abc"]);
    expect(here).toEqual([]);
  });

  it("moves this window from the main window", () => {
    const sent = shell({});
    const here: string[] = [];
    navigateFromHere("/chat/abc", (p) => here.push(p));
    expect(sent).toEqual([]);
    expect(here).toEqual(["/chat/abc"]);
  });

  it("moves this window in a browser tab, where there is no main window", () => {
    shell(null);
    const here: string[] = [];
    navigateFromHere("/chat/abc", (p) => here.push(p));
    expect(here).toEqual(["/chat/abc"]);
  });
});
