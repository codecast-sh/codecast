import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "@/store/inboxStore";
import { adoptPathIntoActiveTab, isNonTabRoute, shouldUseTabRouting, tabNavigate } from "./tabRouting";
import { healTabPaths, shellTabPath } from "@/lib/tabRoutes";

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

  // Public profiles live at the ROOT as a bare handle (/:username), rendered
  // full-page outside the shell. A bare single segment that isn't a known
  // in-shell route must be treated as non-tab, or a signed-in user's in-app
  // click to /<handle> gets intercepted into a blank TabContent pane.
  it("treats root-level profile handles as outside the tab shell", () => {
    for (const p of ["/ashot", "/jane-doe", "/some_user", "/ashot?ref=x"]) {
      expect(isNonTabRoute(p)).toBe(true);
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

  // A hidden background pane (a Cmd-click prewarm tab) canonicalizing its own
  // deep link must move only ITS tab — never the browser URL or the tab the
  // user is looking at. Regression: /files?path=… resolved in a background tab
  // used to router.replace the ACTIVE tab into the Files page.
  it("scopes a background pane's navigation to its own tab, leaving the URL alone", () => {
    const bgTab = { id: "tab_2", title: "Files", path: "/files?path=/x/y.ts", createdAt: 2 };
    useInboxStore.setState({ tabs: [inboxTab, bgTab], activeTabId: inboxTab.id });
    tabNavigate("/files?f=y.ts", "replace", "tab_2");
    expect(calls).toEqual([]);
    const tabs = useInboxStore.getState().tabs;
    expect(tabs.find((t) => t.id === "tab_2")?.path).toBe("/files?f=y.ts");
    expect(tabs.find((t) => t.id === "tab_1")?.path).toBe("/inbox");
  });

  it("navigates normally when the pane's tab IS the active tab", () => {
    tabNavigate("/tasks", "push", "tab_1");
    expect(calls).toEqual([{ op: "push", url: "/tasks", state: { tabNav: true, tabId: "tab_1" } }]);
  });
});

// A tab that holds a path outside the shell renders no pane and pins the URL
// to it — the "blank middle column after every reload" the desktop showed once
// its first tab was seeded from the boot URL `/`.
describe("a tab may only hold a shell route", () => {
  it("shellTabPath falls back to the inbox for outside-shell paths", () => {
    for (const p of ["/", "/login", "/palette", "/people", "/ashot", "", undefined]) {
      expect(shellTabPath(p)).toBe("/inbox");
    }
    for (const p of ["/inbox", "/inbox?s=jx7abc", "/chat/hx7abc", "/tasks/x", "/docs"]) {
      expect(shellTabPath(p)).toBe(p);
    }
  });

  it("healTabPaths rewrites only the offending tabs and is a no-op otherwise", () => {
    const good = [{ id: "a", path: "/inbox?s=x" }, { id: "b", path: "/tasks" }];
    expect(healTabPaths(good)).toBe(good);
    const healed = healTabPaths([{ id: "a", path: "/" }, { id: "b", path: "/tasks" }]);
    expect(healed.map((t) => t.path)).toEqual(["/inbox", "/tasks"]);
  });

  it("updateTab drops an outside-shell path and keeps the rest of the patch", () => {
    useInboxStore.setState({ tabs: [{ ...inboxTab, path: "/inbox?s=jx7abc" }], activeTabId: inboxTab.id });
    useInboxStore.getState().updateTab(inboxTab.id, { path: "/", title: "Home" });
    expect(useInboxStore.getState().tabs[0]).toMatchObject({ path: "/inbox?s=jx7abc", title: "Home" });
    useInboxStore.getState().updateTab(inboxTab.id, { path: "/tasks" });
    expect(useInboxStore.getState().tabs[0].path).toBe("/tasks");
  });

  it("openTab seeds the inbox when handed the app root", () => {
    useInboxStore.setState({ tabs: [], activeTabId: null });
    const id = useInboxStore.getState().openTab({ path: "/", title: "Home" });
    expect(useInboxStore.getState().tabs.find((t) => t.id === id)?.path).toBe("/inbox");
  });

  it("stamping the active tab keeps its path while the live URL is outside the shell", () => {
    const realWindow = (globalThis as any).window;
    const at = (pathname: string) => { (globalThis as any).window = { location: { pathname, search: "" } }; };
    try {
      useInboxStore.setState({ tabs: [inboxTab], activeTabId: inboxTab.id });
      at("/");
      useInboxStore.getState().saveCurrentTabState();
      expect(useInboxStore.getState().tabs[0].path).toBe("/inbox");
      at("/tasks");
      useInboxStore.getState().saveCurrentTabState();
      expect(useInboxStore.getState().tabs[0].path).toBe("/tasks");
    } finally {
      if (realWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = realWindow;
    }
  });
});

// "Open team" on the create flow (a non-tab route) must land on the team feed.
// The shell re-asserts the active tab's stored path on re-entry, so the flow
// adopts the target path into the active tab before the real navigation.
describe("adoptPathIntoActiveTab", () => {
  it("points the active tab at the target path", () => {
    useInboxStore.setState({ tabs: [{ ...inboxTab }], activeTabId: inboxTab.id });
    adoptPathIntoActiveTab("/team/activity");
    expect(useInboxStore.getState().tabs[0].path).toBe("/team/activity");
  });

  it("does nothing when no tab shell exists", () => {
    useInboxStore.setState({ tabs: [], activeTabId: null });
    expect(() => adoptPathIntoActiveTab("/team/activity")).not.toThrow();
    expect(useInboxStore.getState().tabs).toEqual([]);
  });
});
