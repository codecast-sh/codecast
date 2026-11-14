import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type AppTab } from "../../store/inboxStore";
import { leavesOf } from "../../store/stageSplit";
import {
  applyCanvasStep,
  CANVAS_STATE_CAP,
  canvasLeafId,
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
  it("busts the frame per version and carries gates and identity", () => {
    const url = canvasPageUrl("aaa111", 3, "&k=key", "tok");
    expect(url).toMatch(/\/cli\/a\/aaa111\?r=v3&k=key#i=tok$/);
    expect(canvasPageUrl("aaa111", 4, "")).not.toBe(canvasPageUrl("aaa111", 3, ""));
  });
  it("drops the leading ampersand when the version is unknown", () => {
    expect(canvasPageUrl("aaa111", undefined, "&k=key")).toMatch(/aaa111\?k=key$/);
  });
});

describe("planCanvas", () => {
  it("docks, re-points, leaves alone, and takes another session's page away", () => {
    expect(planCanvas({ on: true, leafPath: null, wantPath: "/b?1" })).toBe("insert");
    expect(planCanvas({ on: true, leafPath: "/b?1", wantPath: "/b?2" })).toBe("set");
    expect(planCanvas({ on: true, leafPath: "/b?1", wantPath: "/b?1" })).toBe("none");
    expect(planCanvas({ on: true, leafPath: "/b?1", wantPath: null })).toBe("none");
    expect(planCanvas({ on: false, leafPath: "/b?1", wantPath: null })).toBe("close");
    expect(planCanvas({ on: false, leafPath: null, wantPath: null })).toBe("none");
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
    const v1 = canvasPanePath(canvasPageUrl("aaa111", 1, ""), "conv1");
    expect(applyCanvasStep("insert", v1)).toBe(true);
    expect(canvasLeafPath()).toBe(v1);
    expect(active().path).toBe("/inbox?s=conv1");
    expect(active().focusedLeafId).not.toBe(canvasLeafId("t1"));

    const v2 = canvasPanePath(canvasPageUrl("aaa111", 2, ""), "conv1");
    applyCanvasStep("set", v2);
    expect(canvasLeafPath()).toBe(v2);
    expect(active().path).toBe("/inbox?s=conv1");
    expect(leavesOf(active().layout!)).toHaveLength(2);

    applyCanvasStep("close", null);
    expect(active().layout).toBeUndefined();
    expect(canvasLeafPath()).toBeNull();
  });

  it("refuses to dock on a full stage", () => {
    st().stageInsertLeaf("root", "right", "/docs");
    st().stageInsertLeaf("root", "right", "/plans");
    st().stageInsertLeaf("root", "right", "/tasks/ct-1");
    expect(applyCanvasStep("insert", canvasPanePath(canvasPageUrl("aaa111", 1, ""), "conv1"))).toBe(false);
    expect(canvasLeafPath()).toBeNull();
  });

  it("persists on, pin and off through client state", () => {
    setSessionCanvas("conv1", true, "aaa111");
    expect(st().clientState.ui?.session_canvas?.conv1?.pin).toBe("aaa111");
    setSessionCanvas("conv1", false);
    expect(st().clientState.ui?.session_canvas).toEqual({});
  });
});
