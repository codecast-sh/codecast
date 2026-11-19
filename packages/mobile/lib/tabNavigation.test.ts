import { afterEach, describe, expect, test } from "bun:test";
import { goToTab, insideTabs, isTabAddress, noteRouteSegments } from "./tabNavigation";

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    router: {
      navigate: (href: never) => { calls.push(`navigate ${href}`); },
      dismissTo: (href: never) => { calls.push(`dismissTo ${href}`); },
    },
  };
}

afterEach(() => noteRouteSegments([]));

describe("isTabAddress", () => {
  test("the tabs group and anything under it", () => {
    expect(isTabAddress("/(tabs)")).toBe(true);
    expect(isTabAddress("/(tabs)/inbox")).toBe(true);
    expect(isTabAddress("/(tabs)/tasks?segment=plans")).toBe(true);
    expect(isTabAddress("/(tabs)?x=1")).toBe(true);
  });

  test("a screen stacked over the tabs is not one", () => {
    expect(isTabAddress("/session/jx7abc")).toBe(false);
    expect(isTabAddress("/settings/vault")).toBe(false);
    expect(isTabAddress("/decisions")).toBe(false);
    expect(isTabAddress("/(tabs)x/inbox")).toBe(false);
  });
});

describe("insideTabs", () => {
  test("a tab on top is inside; a screen over the tabs is not", () => {
    expect(insideTabs(["(tabs)", "inbox"])).toBe(true);
    expect(insideTabs(["(tabs)"])).toBe(true);
    expect(insideTabs(["session", "[id]"])).toBe(false);
    expect(insideTabs(["person", "[id]"])).toBe(false);
  });

  test("before the first route is known, the call that cannot do nothing wins", () => {
    expect(insideTabs([])).toBe(true);
  });
});

describe("goToTab", () => {
  test("from a conversation it pops back to the tabs that are there", () => {
    const r = recorder();
    goToTab(r.router, "/(tabs)/inbox", ["session", "[id]"]);
    expect(r.calls).toEqual(["dismissTo /(tabs)/inbox"]);
  });

  test("from inside the tabs it switches tabs in place", () => {
    const r = recorder();
    goToTab(r.router, "/(tabs)/tasks?segment=plans", ["(tabs)", "inbox"]);
    expect(r.calls).toEqual(["navigate /(tabs)/tasks?segment=plans"]);
  });

  test("with no place given it reads where the root layout says the app is", () => {
    const r = recorder();
    noteRouteSegments(["person", "[id]"]);
    goToTab(r.router, "/(tabs)/chat");
    noteRouteSegments(["(tabs)", "chat"]);
    goToTab(r.router, "/(tabs)/settings");
    expect(r.calls).toEqual(["dismissTo /(tabs)/chat", "navigate /(tabs)/settings"]);
  });
});
