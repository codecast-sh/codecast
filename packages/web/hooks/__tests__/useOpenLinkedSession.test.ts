import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { openConversationBeside, resolveLinkedSessionOpen } from "../useOpenLinkedSession";
import { resolveSessionSelectKind } from "../../lib/inboxRouting";
import { useInboxStore, type InboxSession } from "../../store/inboxStore";
import { leavesOf } from "../../store/stageSplit";
import { declareViewNav } from "../../store/viewNav";

const kindFor = (surface: Partial<Parameters<typeof resolveSessionSelectKind>[0]>) =>
  resolveSessionSelectKind({
    isOnSettingsPage: false,
    isOnInboxPage: false,
    ...surface,
  });

describe("resolveLinkedSessionOpen", () => {
  // Regression: workflow-widget agent rows inside an inbox conversation were a
  // dead click -- the hook always called openSidePanel, but the side-column
  // conversation peek doesn't render on the inbox page, so nothing opened.
  it("selects in place on the inbox page instead of peeking", () => {
    expect(resolveLinkedSessionOpen(kindFor({ isOnInboxPage: true }), false)).toBe("select");
  });

  it("routes to the stage from every other page — side by side is a drag, not a click", () => {
    expect(resolveLinkedSessionOpen(kindFor({}), false)).toBe("route");
  });

  it("routes on narrow viewports regardless of surface", () => {
    expect(resolveLinkedSessionOpen(kindFor({}), true)).toBe("route");
    expect(resolveLinkedSessionOpen(kindFor({ isOnInboxPage: true }), true)).toBe("route");
  });

  it("routes from Settings, where selecting a session means leaving", () => {
    expect(resolveLinkedSessionOpen(kindFor({ isOnSettingsPage: true, isOnInboxPage: true }), false)).toBe("route");
  });
});

describe("openConversationBeside", () => {
  const session = (id: string, extra?: Partial<InboxSession>): InboxSession => ({
    _id: id,
    session_id: `s-${id}`,
    updated_at: Date.now(),
    agent_type: "claude_code",
    message_count: 1,
    is_idle: true,
    has_pending: false,
    ...extra,
  });

  // The gate reads the window's width; bun has no window, so stub the two
  // fields the gesture touches (openBeside's width, syncUrl's location).
  const hadWindow = typeof (globalThis as any).window !== "undefined";
  beforeAll(() => {
    if (!hadWindow) (globalThis as any).window = { innerWidth: 1400 };
  });
  afterAll(() => {
    if (!hadWindow) delete (globalThis as any).window;
  });

  beforeEach(() => {
    declareViewNav("gesture");
    (globalThis as any).window.innerWidth = 1400;
    useInboxStore.setState({
      sessions: { a: session("a"), b: session("b") },
      currentSessionId: "a",
      viewingDismissedId: null,
      tabs: [{ id: "t1", title: "Tasks", path: "/tasks", createdAt: 0 }],
      activeTabId: "t1",
    } as any);
  });

  it("splits the conversation in beside the page as a stage pane", () => {
    openConversationBeside("b");
    const tab = useInboxStore.getState().tabs[0];
    expect(tab.layout).toBeDefined();
    expect(leavesOf(tab.layout!).map((l) => l.path)).toEqual(["/tasks", "/conversation/b"]);
    // The newcomer is focused, and the tab's path mirrors it.
    expect(tab.path).toBe("/conversation/b");
    expect(tab.focusedLeafId).toBe(leavesOf(tab.layout!)[1].id);
  });

  it("focuses a pane that already shows the conversation instead of doubling it", () => {
    openConversationBeside("b");
    const first = useInboxStore.getState().tabs[0].layout!;
    openConversationBeside("b");
    const tab = useInboxStore.getState().tabs[0];
    expect(leavesOf(tab.layout!)).toHaveLength(2);
    expect(tab.layout).toBe(first);
  });

  it("falls back to the stage on a narrow window", () => {
    (globalThis as any).window.innerWidth = 700;
    openConversationBeside("b");
    const s = useInboxStore.getState();
    expect(s.tabs[0].layout).toBeUndefined();
    expect(s.currentSessionId).toBe("b");
  });
});
