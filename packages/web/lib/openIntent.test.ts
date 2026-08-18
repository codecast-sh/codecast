import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "@/store/inboxStore";
import {
  beginClickIntent,
  divertNavigation,
  divertSessionOpen,
  endClickIntent,
  isPrewarmTab,
  openTargetForClick,
  pendingOpenTarget,
} from "./openIntent";

const inboxTab = { id: "tab_1", title: "Inbox", path: "/inbox", createdAt: 1 };
const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("openTargetForClick", () => {
  it("maps the browser's tab gestures", () => {
    expect(openTargetForClick({ button: 0 })).toBeNull();
    expect(openTargetForClick({ button: 0, metaKey: true })).toBe("tab");
    expect(openTargetForClick({ button: 0, ctrlKey: true })).toBe("tab");
    expect(openTargetForClick({ button: 1 })).toBe("tab");
    expect(openTargetForClick({ button: 0, metaKey: true, shiftKey: true })).toBe("window");
    // Shift alone and Alt (browser "download") are not ours.
    expect(openTargetForClick({ button: 0, shiftKey: true })).toBeNull();
    expect(openTargetForClick({ button: 0, metaKey: true, altKey: true })).toBeNull();
    expect(openTargetForClick({ button: 2, metaKey: true })).toBeNull();
  });
});

describe("divertNavigation", () => {
  const realWindow = (globalThis as any).window;
  let opened: string[];

  beforeEach(() => {
    useInboxStore.setState({ tabs: [inboxTab], activeTabId: inboxTab.id });
    opened = [];
    (globalThis as any).window = {
      location: { pathname: "/inbox", search: "", origin: "https://codecast.sh", href: "https://codecast.sh/inbox" },
      open: (url: string) => { opened.push(url); },
    };
  });

  afterEach(() => {
    endClickIntent();
    if (realWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = realWindow;
  });

  it("is a no-op for a plain click", () => {
    expect(pendingOpenTarget()).toBeNull();
    expect(divertNavigation("/tasks/ct-1")).toBe(false);
    expect(useInboxStore.getState().tabs).toHaveLength(1);
  });

  it("opens a Cmd-click's path in a background, prewarmed tab", async () => {
    beginClickIntent("tab");
    expect(divertNavigation("/tasks/ct-1")).toBe(true);
    await flush();
    const { tabs, activeTabId } = useInboxStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs[1].path).toBe("/tasks/ct-1");
    expect(activeTabId).toBe(inboxTab.id); // background: the view stays put
    expect(isPrewarmTab(tabs[1].id)).toBe(true);
  });

  it("claims the intent once: a second navigation in the same click stands down", async () => {
    beginClickIntent("tab");
    expect(divertNavigation("/tasks/ct-1")).toBe(true);
    // e.g. handleLeaveAndOpenSession: navigateToSession(id) then router.push("/inbox")
    expect(divertNavigation("/inbox")).toBe(true);
    await flush();
    expect(useInboxStore.getState().tabs).toHaveLength(2);
  });

  it("a replace never claims the intent but stands down once a sibling did", async () => {
    beginClickIntent("tab");
    expect(divertNavigation("/tasks?view=board", { openable: false })).toBe(false);
    expect(divertNavigation("/tasks/ct-1")).toBe(true);
    expect(divertNavigation("/tasks", { openable: false })).toBe(true);
    await flush();
    expect(useInboxStore.getState().tabs.map((t) => t.path)).toEqual(["/inbox", "/tasks/ct-1"]);
  });

  it("holds a session tab on the inbox deep-link form, with its session id", async () => {
    beginClickIntent("tab");
    expect(divertNavigation("/conversation/jx7abc")).toBe(true);
    await flush();
    const tab = useInboxStore.getState().tabs[1];
    expect(tab.path).toBe("/inbox?s=jx7abc");
    expect(tab.sessionId).toBe("jx7abc");
  });

  it("Cmd-Shift opens a window (browser tab where there is no desktop bridge)", async () => {
    beginClickIntent("window");
    expect(divertSessionOpen("jx7abc", { messageId: "m1" })).toBe(true);
    await flush();
    expect(useInboxStore.getState().tabs).toHaveLength(1);
    expect(opened).toEqual(["/conversation/jx7abc#msg-m1"]);
  });

  it("clears on the next macrotask even when nothing claimed it", async () => {
    beginClickIntent("tab");
    await new Promise((r) => setTimeout(r, 1));
    expect(pendingOpenTarget()).toBeNull();
    expect(divertNavigation("/tasks")).toBe(false);
  });
});
