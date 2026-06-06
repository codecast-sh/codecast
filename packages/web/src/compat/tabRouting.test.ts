import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "@/store/inboxStore";
import { isNonTabRoute, shouldUseTabRouting, tabNavigate } from "./tabRouting";

const inboxTab = { id: "tab_1", title: "Inbox", path: "/inbox", createdAt: 1 };

describe("isNonTabRoute", () => {
  it("treats marketing, auth, and public routes as outside the tab shell", () => {
    for (const p of [
      "/", "/about", "/features", "/documentation", "/privacy", "/security",
      "/support", "/terms", "/login", "/signup", "/forgot-password",
      "/reset-password", "/auth/cli", "/join/abc123", "/share/tok",
      "/share/message/tok", "/settings", "/settings/cli", "/palette",
      "/login?return_to=%2Finbox",
    ]) {
      expect(isNonTabRoute(p)).toBe(true);
    }
  });

  it("treats dashboard routes as inside the tab shell", () => {
    for (const p of [
      "/inbox", "/feed", "/conversation/abc", "/tasks", "/tasks/x",
      "/docs", "/docs/y", "/plans", "/projects", "/team", "/cli",
    ]) {
      expect(isNonTabRoute(p)).toBe(false);
    }
  });
});

describe("shouldUseTabRouting", () => {
  beforeEach(() => {
    useInboxStore.setState({ tabs: [inboxTab], activeTabId: inboxTab.id });
  });

  it("intercepts navigation between dashboard routes when a tab is active", () => {
    expect(shouldUseTabRouting("/conversation/abc", "/inbox")).toBe(true);
  });

  // Regression: clicking "Sign in" on the marketing page used to rewrite the URL
  // to /login via replaceState without navigating React Router, because the tab
  // (persisted from prior dashboard use) made tab routing kick in. It must not.
  it("does NOT intercept on marketing/auth routes even with a persisted tab", () => {
    expect(shouldUseTabRouting("/login", "/")).toBe(false);
    expect(shouldUseTabRouting("/signup", "/")).toBe(false);
  });

  it("does NOT intercept when leaving the shell for an auth route", () => {
    expect(shouldUseTabRouting("/login", "/inbox")).toBe(false);
  });

  it("does NOT intercept external links", () => {
    expect(shouldUseTabRouting("https://example.com", "/inbox")).toBe(false);
  });

  it("does NOT intercept when no tab is active", () => {
    useInboxStore.setState({ tabs: [], activeTabId: null });
    expect(shouldUseTabRouting("/conversation/abc", "/inbox")).toBe(false);
  });
});

describe("tabNavigate", () => {
  let calls: Array<{ op: "push" | "replace"; url: string; state: any }>;
  const realWindow = (globalThis as any).window;

  beforeEach(() => {
    useInboxStore.setState({ tabs: [inboxTab], activeTabId: inboxTab.id });
    calls = [];
    (globalThis as any).window = {
      location: { pathname: "/inbox", search: "" },
      history: {
        pushState: (state: any, _t: string, url: string) => calls.push({ op: "push", url, state }),
        replaceState: (state: any, _t: string, url: string) => calls.push({ op: "replace", url, state }),
      },
    };
  });

  afterEach(() => {
    if (realWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = realWindow;
  });

  it("pushes a new history entry for a navigation to a different path", () => {
    tabNavigate("/tasks", "push");
    expect(calls).toEqual([{ op: "push", url: "/tasks", state: { tabNav: true, tabId: "tab_1" } }]);
  });

  // A push whose target equals the current URL must NOT stack a duplicate entry —
  // otherwise re-selecting the current page would pile up dead back-stack entries.
  it("downgrades a same-URL push to replace", () => {
    tabNavigate("/inbox", "push");
    expect(calls).toEqual([{ op: "replace", url: "/inbox", state: { tabNav: true, tabId: "tab_1" } }]);
  });

  it("replaces (no new entry) in replace mode", () => {
    tabNavigate("/tasks", "replace");
    expect(calls[0].op).toBe("replace");
  });

  it("mirrors the navigation into the active tab's stored path", () => {
    tabNavigate("/tasks/ct-1", "push");
    const tab = useInboxStore.getState().tabs.find((t) => t.id === "tab_1");
    expect(tab?.path).toBe("/tasks/ct-1");
  });
});
