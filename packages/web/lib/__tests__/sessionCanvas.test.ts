import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type AppTab } from "../../store/inboxStore";
import { leavesOf } from "../../store/stageSplit";
import {
  applyCanvasStep,
  CANVAS_STATE_CAP,
  canvasHasFocus,
  canvasLeafId,
  canvasOwner,
  claimCanvas,
  canvasLeafPath,
  canvasPanePath,
  canvasPageUrl,
  canvasTarget,
  planCanvas,
  setSessionCanvas,
  withCanvas,
} from "../sessionCanvas";

const pages = [
  { slug: "aaa111", created_at: 1 },
  { slug: "bbb222", created_at: 3 },
  { slug: "ccc333", created_at: 2 },
];
const none = () => undefined;

describe("canvasTarget", () => {
  it("shows the newest page", () => {
    expect(canvasTarget(pages, null, none)).toBe("bbb222");
  });
  it("keeps a pinned page while it exists", () => {
    expect(canvasTarget(pages, "aaa111", none)).toBe("aaa111");
  });
  it("falls back to the newest when the pin or the newest is gone", () => {
    const info = (s: string) => (s === "bbb222" || s === "aaa111" ? { missing: true as const, gateKeys: "" } : undefined);
    expect(canvasTarget(pages, "aaa111", info)).toBe("ccc333");
  });
  it("is null with no pages", () => {
    expect(canvasTarget([], "aaa111", none)).toBeNull();
  });
});

describe("canvasPageUrl", () => {
  it("busts the frame per version and carries no token of any kind", () => {
    expect(canvasPageUrl("aaa111", 3)).toMatch(/\/cli\/a\/aaa111\?r=v3$/);
    expect(canvasPageUrl("aaa111", 4)).not.toBe(canvasPageUrl("aaa111", 3));
    expect(canvasPageUrl("aaa111", undefined)).toMatch(/\/cli\/a\/aaa111$/);
  });
});

describe("planCanvas", () => {
  const page = (slug: string, v: number, cid = "c1") => canvasPanePath(canvasPageUrl(slug, v), cid);
  const plan = (o: Partial<Parameters<typeof planCanvas>[0]>) =>
    planCanvas({ on: true, conversationId: "c1", leafPath: null, wantPath: null, pending: false, ...o });

  it("docks, re-points and leaves a current pane alone", () => {
    expect(plan({ wantPath: page("a", 1) })).toBe("insert");
    expect(plan({ leafPath: page("a", 1), wantPath: page("a", 2) })).toBe("set");
    expect(plan({ leafPath: page("a", 1), wantPath: page("a", 1) })).toBe("none");
  });
  it("closes its page when off, and nothing when there is none", () => {
    expect(plan({ on: false, leafPath: page("a", 1, "c2") })).toBe("close");
    expect(plan({ on: false })).toBe("none");
  });
  it("keeps its own page while the next version loads", () => {
    expect(plan({ leafPath: page("a", 1), pending: true })).toBe("none");
  });
  it("takes another session's page down while this one's loads, or when it has none", () => {
    expect(plan({ leafPath: page("a", 1, "c2"), pending: true })).toBe("close");
    expect(plan({ leafPath: page("a", 1), pending: false })).toBe("close");
  });
  it("hands the pane to the person once they navigate it elsewhere", () => {
    const elsewhere = "/browser?u=https%3A%2F%2Fexample.com%2F";
    expect(plan({ leafPath: elsewhere, wantPath: page("a", 2) })).toBe("release");
    expect(plan({ on: false, leafPath: elsewhere })).toBe("none");
  });
});

describe("canvas owner", () => {
  it("is per tab, and the last claim wins", () => {
    claimCanvas("tA", "c1");
    claimCanvas("tB", "c2");
    claimCanvas("tA", "c3");
    expect(canvasOwner("tA")).toBe("c3");
    expect(canvasOwner("tB")).toBe("c2");
  });
});

describe("canvasHasFocus", () => {
  const frameIn = (leaf: string | null) => ({
    activeElement: { tagName: "IFRAME", closest: (sel: string) => (leaf && sel === `[data-stage-leaf="${leaf}"]` ? {} : null) },
  }) as any;
  it("holds only while a frame inside this tab's canvas pane has focus", () => {
    expect(canvasHasFocus("t1", frameIn(canvasLeafId("t1")))).toBe(true);
    expect(canvasHasFocus("t1", frameIn("sl_seed_t1"))).toBe(false);
    expect(canvasHasFocus("t1", { activeElement: { tagName: "TEXTAREA", closest: () => ({}) } } as any)).toBe(false);
    expect(canvasHasFocus(undefined, frameIn(canvasLeafId("t1")))).toBe(false);
  });
});

describe("withCanvas", () => {
  it("keeps the newest entries under the cap", () => {
    let s = {};
    for (let i = 0; i <= CANVAS_STATE_CAP; i++) s = withCanvas(s, `c${i}`, null, i);
    expect(Object.keys(s)).toHaveLength(CANVAS_STATE_CAP);
    expect(s).not.toHaveProperty("c0");
    expect(s).toHaveProperty(`c${CANVAS_STATE_CAP}`);
  });
});

describe("stage ops", () => {
  const tab = (): AppTab => ({ id: "t1", title: "A", path: "/inbox?s=conv1", createdAt: 0 });
  const st = () => useInboxStore.getState();
  const active = () => st().tabs.find((t) => t.id === st().activeTabId)!;
  let restore: () => void;
  beforeAll(() => {
    restore = replaceGlobals({
      window: { innerWidth: 1400, location: { pathname: "/inbox", search: "?s=conv1" }, history: { pushState: () => {}, replaceState: () => {} } },
    });
  });
  afterAll(() => restore());
  beforeEach(() => useInboxStore.setState({ tabs: [tab()], activeTabId: "t1", clientState: { ui: {} } } as any));

  it("docks unfocused, re-points in place, and closes back to a plain tab", () => {
    const v1 = canvasPanePath(canvasPageUrl("aaa111", 1), "conv1");
    expect(applyCanvasStep("insert", v1, { tabId: "t1", conversationId: "conv1" })).toBe(true);
    expect(canvasLeafPath()).toBe(v1);
    expect(active().path).toBe("/inbox?s=conv1");
    expect(active().focusedLeafId).not.toBe(canvasLeafId("t1"));

    const v2 = canvasPanePath(canvasPageUrl("aaa111", 2), "conv1");
    applyCanvasStep("set", v2, { tabId: "t1", conversationId: "conv1" });
    expect(canvasLeafPath()).toBe(v2);
    expect(active().path).toBe("/inbox?s=conv1");
    expect(leavesOf(active().layout!)).toHaveLength(2);

    applyCanvasStep("close", null, { tabId: "t1", conversationId: "conv1" });
    expect(active().layout).toBeUndefined();
    expect(canvasLeafPath()).toBeNull();
  });

  it("acts only on its own tab's stage, and only while that tab is on screen", () => {
    useInboxStore.setState({ tabs: [tab(), { ...tab(), id: "t2", path: "/tasks" }], activeTabId: "t2" } as any);
    expect(applyCanvasStep("insert", canvasPanePath(canvasPageUrl("aaa111", 1), "conv1"), { tabId: "t1", conversationId: "conv1" })).toBe(true);
    expect(st().tabs.every((t) => !t.layout)).toBe(true);
  });

  it("closing a focused canvas brings its tab back to the session in view, not a stale one", () => {
    applyCanvasStep("insert", canvasPanePath(canvasPageUrl("aaa111", 1), "conv1"), { tabId: "t1", conversationId: "conv1" });
    st().stageFocusLeaf(canvasLeafId("t1"));
    applyCanvasStep("close", null, { tabId: "t1", conversationId: "conv2", ownerLeafId: "sl_seed_t1" });
    expect(active().layout).toBeUndefined();
    expect(active().path).toBe("/inbox?s=conv2");
  });

  it("refuses to dock on a full stage", () => {
    st().stageInsertLeaf("root", "right", "/docs");
    st().stageInsertLeaf("root", "right", "/plans");
    st().stageInsertLeaf("root", "right", "/tasks/ct-1");
    expect(applyCanvasStep("insert", canvasPanePath(canvasPageUrl("aaa111", 1), "conv1"), { tabId: "t1", conversationId: "conv1" })).toBe(false);
    expect(canvasLeafPath()).toBeNull();
  });

  it("persists on, pin and off through client state", () => {
    setSessionCanvas("conv1", true, "aaa111");
    expect(st().clientState.ui?.session_canvas?.conv1?.pin).toBe("aaa111");
    setSessionCanvas("conv1", false);
    expect(st().clientState.ui?.session_canvas).toEqual({});
  });
});
