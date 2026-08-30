import { describe, expect, it } from "bun:test";
import {
  createWorkspace,
  showPane,
  hidePane,
  togglePane,
  autoAllowed,
  setPresentation,
  promote,
  topOverlay,
  findPane,
  isVisible,
  samePane,
  surfaceForPath,
  slotPolicyFor,
  serializeWorkspace,
  hydrateWorkspace,
  setSize,
  type Pane,
} from "../workspace";

const convo = (ref: string): Pane => ({ kind: "conversation", ref });
const detail = (ref: string): Pane => ({ kind: "detail", ref });
const sessionList: Pane = { kind: "sessionList" };
const comments = (ref: string): Pane => ({ kind: "comments", ref });

describe("the cap", () => {
  // The whole point of slots: a second pane REPLACES the first, so a region can
  // never accumulate columns. This is what the hand-written caps kept missing.
  it("replaces rather than accumulates", () => {
    let ws = createWorkspace();
    ws = showPane(ws, "secondary", convo("a"));
    ws = showPane(ws, "secondary", convo("b"));
    expect(ws.secondary.pane).toEqual(convo("b"));
    expect(findPane(ws, convo("a"))).toBeNull();
  });

  // The session list and the comment rail both wanted the right edge and could
  // both be open; sharing one slot makes that unrepresentable.
  it("gives the context edge to one pane at a time", () => {
    let ws = showPane(createWorkspace(), "context", sessionList);
    ws = showPane(ws, "context", comments("c1"));
    expect(ws.context.pane).toEqual(comments("c1"));
  });
});

describe("sticky dismissal", () => {
  it("suppresses automatic reopen of the pane the user closed", () => {
    let ws = showPane(createWorkspace(), "secondary", convo("a"));
    ws = hidePane(ws, "secondary", { remember: true });
    expect(ws.secondary.pane).toBeNull();
    expect(autoAllowed(ws, "secondary", convo("a"))).toBe(false);
  });

  it("does not suppress a different pane", () => {
    let ws = showPane(createWorkspace(), "secondary", convo("a"));
    ws = hidePane(ws, "secondary", { remember: true });
    expect(autoAllowed(ws, "secondary", convo("b"))).toBe(true);
  });

  it("an explicit show beats an earlier hand-close of the same pane", () => {
    let ws = showPane(createWorkspace(), "secondary", convo("a"));
    ws = hidePane(ws, "secondary", { remember: true });
    ws = showPane(ws, "secondary", convo("a"));
    expect(ws.secondary.pane).toEqual(convo("a"));
    expect(autoAllowed(ws, "secondary", convo("a"))).toBe(true);
  });

  // Closing because the surface went away is bookkeeping, not a decision —
  // the pane must be free to come back when the surface returns.
  it("bookkeeping close leaves the pane free to return", () => {
    let ws = showPane(createWorkspace(), "secondary", convo("a"));
    ws = hidePane(ws, "secondary", { remember: false });
    expect(autoAllowed(ws, "secondary", convo("a"))).toBe(true);
  });
});

describe("presentation", () => {
  // peek → pin is a presentation change, not a different component or mode.
  it("moves a pane between peek and split without losing it", () => {
    let ws = showPane(createWorkspace(), "secondary", detail("d1"), { presentation: "overlay" });
    expect(ws.secondary.presentation).toBe("overlay");
    ws = setPresentation(ws, "secondary", "split");
    expect(ws.secondary.presentation).toBe("split");
    expect(ws.secondary.pane).toEqual(detail("d1"));
  });

  it("counts a collapsed slot as not visible but still occupied", () => {
    const ws = setPresentation(showPane(createWorkspace(), "context", sessionList), "context", "collapsed");
    expect(isVisible(ws, "context")).toBe(false);
    expect(ws.context.pane).toEqual(sessionList);
  });

  it("re-showing into a collapsed slot re-opens it", () => {
    let ws = setPresentation(createWorkspace(), "context", "collapsed");
    ws = showPane(ws, "context", sessionList);
    expect(ws.context.presentation).toBe("split");
  });
});

describe("promote", () => {
  it("swaps the pane onto the stage and takes the displaced one back", () => {
    let ws = createWorkspace();
    ws = showPane(ws, "primary", detail("task-1"));
    ws = showPane(ws, "secondary", convo("s1"));
    ws = promote(ws, "secondary");
    expect(ws.primary.pane).toEqual(convo("s1"));
    expect(ws.secondary.pane).toEqual(detail("task-1"));
  });

  // A route-rendered page is not a movable object; promoting over it empties
  // the slot instead of parking "page" somewhere it can't render.
  it("does not park the route page in a slot", () => {
    let ws = showPane(createWorkspace(), "secondary", convo("s1"));
    ws = promote(ws, "secondary");
    expect(ws.primary.pane).toEqual(convo("s1"));
    expect(ws.secondary.pane).toBeNull();
  });
});

describe("toggle", () => {
  it("closes the same pane and remembers it", () => {
    let ws = togglePane(createWorkspace(), "context", sessionList);
    expect(ws.context.pane).toEqual(sessionList);
    ws = togglePane(ws, "context", sessionList);
    expect(ws.context.pane).toBeNull();
    expect(autoAllowed(ws, "context", sessionList)).toBe(false);
  });

  it("swaps when a different pane is up", () => {
    let ws = togglePane(createWorkspace(), "context", sessionList);
    ws = togglePane(ws, "context", comments("c1"));
    expect(ws.context.pane).toEqual(comments("c1"));
  });
});

describe("escape target", () => {
  // One Esc rule for the whole app instead of a keydown listener per region.
  it("names the topmost overlay and ignores split panes", () => {
    let ws = createWorkspace();
    ws = showPane(ws, "context", sessionList, { presentation: "split" });
    expect(topOverlay(ws)).toBeNull();
    ws = showPane(ws, "secondary", detail("d1"), { presentation: "overlay" });
    expect(topOverlay(ws)).toBe("secondary");
  });
});

describe("pane identity", () => {
  it("distinguishes subjects within a kind", () => {
    expect(samePane(convo("a"), convo("a"))).toBe(true);
    expect(samePane(convo("a"), convo("b"))).toBe(false);
    expect(samePane(convo("a"), detail("a"))).toBe(false);
    expect(samePane(null, null)).toBe(true);
    expect(samePane(null, convo("a"))).toBe(false);
  });
});

describe("route → slot defaults", () => {
  it("classifies the surfaces the shell distinguishes", () => {
    expect(surfaceForPath("/inbox")).toBe("inbox");
    expect(surfaceForPath("/inbox?s=abc")).toBe("inbox");
    expect(surfaceForPath("/conversation/abc")).toBe("conversation");
    expect(surfaceForPath("/tasks")).toBe("working");
    expect(surfaceForPath("/tasks/ct-1")).toBe("working");
    expect(surfaceForPath("/docs/d1")).toBe("working");
    expect(surfaceForPath("/plans")).toBe("working");
    // Settings must win even though the tab shell reports a carried /inbox path.
    expect(surfaceForPath("/settings/profile")).toBe("settings");
    expect(surfaceForPath("/workflows")).toBe("plain");
  });

  // No route defaults a second column any more: side by side is the tab's
  // split layout, entered by a drag. The inbox alone hosts the board's
  // drill-in as an overlay — a visit over the stage, never a second column.
  it("never defaults a split; the inbox allows the overlay drill-in", () => {
    expect(slotPolicyFor("working").secondary).toBe(false);
    expect(slotPolicyFor("inbox").secondary).toBe("overlay");
    expect(slotPolicyFor("conversation").secondary).toBe(false);
    expect(slotPolicyFor("settings").secondary).toBe(false);
  });

  it("keeps the session rail available everywhere", () => {
    for (const s of ["inbox", "conversation", "working", "settings", "plain"] as const) {
      expect(slotPolicyFor(s).context).toBe(true);
    }
  });
});

describe("slot persistence scopes", () => {
  // The terminal's device-local nature is now DATA in the model, not a region
  // that opts out of it: the dock never rides the shared projection.
  it("keeps device slots out of the shared projection", () => {
    let ws = showPane(createWorkspace(), "context", sessionList);
    ws = showPane(ws, "dock", { kind: "terminal" });
    const shared = serializeWorkspace(ws, "shared");
    const device = serializeWorkspace(ws, "device");
    expect(shared.dock).toBeUndefined();
    expect(shared.context?.kind).toBe("sessionList");
    expect(device.dock?.kind).toBe("terminal");
    expect(device.context).toBeUndefined();
  });

  it("rebuilds a workspace from both scopes", () => {
    let ws = showPane(createWorkspace(), "context", sessionList);
    ws = setSize(showPane(ws, "dock", { kind: "terminal" }), "dock", 320);
    const back = hydrateWorkspace(serializeWorkspace(ws, "shared"), serializeWorkspace(ws, "device"));
    expect(back.context.pane).toEqual(sessionList);
    expect(back.dock.pane).toEqual({ kind: "terminal" });
    expect(back.dock.size).toBe(320);
  });

  // A shared arrangement synced from another device must not switch on a
  // terminal here — the device scope is what answers for the dock.
  it("ignores a foreign dock arriving in the shared projection", () => {
    const foreign = { ...serializeWorkspace(showPane(createWorkspace(), "dock", { kind: "terminal" }), "shared"), dock: { kind: "terminal" as const, presentation: "split" as const } };
    const back = hydrateWorkspace(foreign, null);
    expect(back.dock.pane).toBeNull();
  });
});
