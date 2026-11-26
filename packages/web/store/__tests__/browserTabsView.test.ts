import { describe, expect, it } from "bun:test";
import { BROWSER_TABS_STALE_MS } from "@codecast/shared/contracts";
import { browserTabsByConversation, groupSessionsByBrowser, tabHost, type BrowserTabRow } from "../browserTabsView";
import { inboxViewModes } from "../inboxViewModes";

const NOW = 1_000_000_000;
const row = (id: string, conv: string, extra: Partial<BrowserTabRow> = {}): BrowserTabRow => ({
  _id: id, conversation_id: conv, session_id: `s-${conv}`, device_id: "laptop",
  tabs: [{ id: `t-${id}`, title: `Tab ${id}`, url: "https://example.com/a", where: "chrome" }],
  last_used_at: NOW - 1_000, reported_at: NOW - 1_000, ...extra,
});

describe("browser view", () => {
  it("merges a session's tabs across machines and drops rows its daemon stopped vouching for", () => {
    const byConv = browserTabsByConversation({
      a: row("a", "c1"),
      b: row("b", "c1", { device_id: "desktop", last_used_at: NOW - 10 }),
      stale: row("stale", "c2", { reported_at: NOW - BROWSER_TABS_STALE_MS - 1 }),
    }, NOW);
    expect([...byConv.keys()]).toEqual(["c1"]);
    expect(byConv.get("c1")).toEqual({ tabs: [row("a", "c1").tabs[0], row("b", "c1").tabs[0]], lastUsedAt: NOW - 10 });
  });

  it("lists only sessions with a tab, most recently driven first", () => {
    const byConv = browserTabsByConversation({ a: row("a", "c1", { last_used_at: NOW - 500 }), b: row("b", "c3", { last_used_at: NOW - 5 }) }, NOW);
    const sessions = [{ _id: "c1" }, { _id: "c2" }, { _id: "c3" }];
    expect(groupSessionsByBrowser(sessions, byConv).map((s) => s._id)).toEqual(["c3", "c1"]);
  });

  it("is offered only while a session has a tab", () => {
    const base = { hasLabels: false, hasPlans: false, orgLenses: [], hasTriggers: false, hasMachines: false };
    expect(inboxViewModes({ ...base, hasBrowser: true })).toContain("browser");
    expect(inboxViewModes(base)).not.toContain("browser");
  });

  it("names a tab by its host", () => {
    expect(tabHost("https://x.com/home")).toBe("x.com");
    expect(tabHost("not a url")).toBe("not a url");
  });
});
