import { beforeEach, describe, expect, it } from "bun:test";
import { mergeStampedBagLww, useInboxStore } from "../inboxStore";

// The `dismissed` preference bag syncs per-key last-writer-wins via ":ts"
// stamps (mergeStampedBagLww) instead of blanket local_wins. Regression for
// the "Open links in desktop app" toggle showing ON on one device while the
// server — and the browser client that actually decides the hand-off — said
// OFF: local_wins meant a preference written on one device could never reach
// another that already had its own copy of the bag.

describe("mergeStampedBagLww", () => {
  it("takes the server wholesale before hydration finishes", () => {
    expect(mergeStampedBagLww({ a: 1 }, { a: 2 }, false)).toEqual({ a: 2 });
  });

  it("a newer server stamp wins the key (cross-device toggle propagates)", () => {
    const local = { prefer_browser_links: false, "prefer_browser_links:ts": 100 };
    const server = { prefer_browser_links: true, "prefer_browser_links:ts": 200 };
    expect(mergeStampedBagLww(local, server, true)).toEqual(server);
  });

  it("a newer local stamp survives a stale server echo (no flicker)", () => {
    const local = { prefer_browser_links: false, "prefer_browser_links:ts": 300 };
    const server = { prefer_browser_links: true, "prefer_browser_links:ts": 200 };
    expect(mergeStampedBagLww(local, server, true)).toEqual(local);
  });

  it("unstamped keys keep local_wins per-key semantics (legacy bags)", () => {
    const local = { has_used_desktop: true };
    const server = { has_used_desktop: false, desktop_app: true };
    // local value beats the echo; the server-only key flows in.
    expect(mergeStampedBagLww(local, server, true)).toEqual({ has_used_desktop: true, desktop_app: true });
  });

  it("a stamped write beats an unstamped legacy value on either side", () => {
    const stamped = { prefer_browser_links: false, "prefer_browser_links:ts": 100 };
    const legacy = { prefer_browser_links: true };
    expect(mergeStampedBagLww(stamped, legacy, true).prefer_browser_links).toBe(false);
    expect(mergeStampedBagLww(legacy, stamped, true).prefer_browser_links).toBe(false);
  });
});

// The ui bag rides the same stamped-LWW merge, but only for the whitelisted
// inbox-VIEW keys (STAMPED_UI_KEYS): the toolbar configuration (scope, view
// mode, subagents/old toggles) follows the user across devices, while
// layout-ish per-device prefs (sidebar, zen mode, theme) stay on exact legacy
// local_wins semantics by staying unstamped.
describe("updateClientUI stamped view keys", () => {
  beforeEach(() => {
    useInboxStore.setState({ clientState: {}, clientStateInitialized: true, pending: {} });
  });

  it("stamps inbox-view keys so the toolbar follows the user across devices", () => {
    const before = Date.now();
    useInboxStore.getState().updateClientUI({ inbox_scope: "team", show_subagents: true });
    const ui = useInboxStore.getState().clientState.ui as Record<string, any>;
    expect(ui.inbox_scope).toBe("team");
    expect(ui["inbox_scope:ts"]).toBeGreaterThanOrEqual(before);
    expect(ui["show_subagents:ts"]).toBeGreaterThanOrEqual(before);
  });

  it("leaves per-device keys unstamped (legacy local_wins semantics)", () => {
    useInboxStore.getState().updateClientUI({ sidebar_collapsed: true });
    const ui = useInboxStore.getState().clientState.ui as Record<string, any>;
    expect(ui.sidebar_collapsed).toBe(true);
    expect(ui["sidebar_collapsed:ts"]).toBeUndefined();
  });

  it("adopts a NEWER view-mode change from another device on sync", () => {
    useInboxStore.getState().updateClientUI({ inbox_view_mode: "grouped" });
    const newer = Date.now() + 5_000;
    useInboxStore.getState().syncTable("clientState", {
      ui: { inbox_view_mode: "recent", "inbox_view_mode:ts": newer },
    });
    expect(useInboxStore.getState().clientState.ui?.inbox_view_mode).toBe("recent");
  });

  it("a just-made local write survives a stale server echo (no flicker)", () => {
    useInboxStore.getState().updateClientUI({ inbox_scope: "team" });
    useInboxStore.getState().syncTable("clientState", {
      ui: { inbox_scope: "mine", "inbox_scope:ts": Date.now() - 60_000 },
    });
    expect(useInboxStore.getState().clientState.ui?.inbox_scope).toBe("team");
  });
});

describe("updateClientDismissed", () => {
  beforeEach(() => {
    useInboxStore.setState({ clientState: {}, clientStateInitialized: true, pending: {} });
  });

  it("stamps the value with a ts so the write can win LWW everywhere", () => {
    const before = Date.now();
    useInboxStore.getState().updateClientDismissed("prefer_browser_links", false);
    const bag = useInboxStore.getState().clientState.dismissed as Record<string, any>;
    expect(bag.prefer_browser_links).toBe(false);
    expect(bag["prefer_browser_links:ts"]).toBeGreaterThanOrEqual(before);
  });

  it("a stamped local write then survives a server echo carrying the old value", () => {
    useInboxStore.getState().updateClientDismissed("prefer_browser_links", false);
    useInboxStore.getState().syncTable("clientState", { dismissed: { prefer_browser_links: true } });
    const bag = useInboxStore.getState().clientState.dismissed as Record<string, any>;
    expect(bag.prefer_browser_links).toBe(false);
  });

  it("adopts a NEWER change from another device on sync", () => {
    useInboxStore.getState().updateClientDismissed("prefer_browser_links", false);
    const newer = Date.now() + 5_000;
    useInboxStore.getState().syncTable("clientState", {
      dismissed: { prefer_browser_links: true, "prefer_browser_links:ts": newer },
    });
    const bag = useInboxStore.getState().clientState.dismissed as Record<string, any>;
    expect(bag.prefer_browser_links).toBe(true);
  });
});
