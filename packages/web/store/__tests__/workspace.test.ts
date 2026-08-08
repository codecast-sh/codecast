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
