import { describe, expect, test } from "bun:test";
import {
  anchorFromRects,
  applyFollowView,
  composeLeaderView,
  followersLabel,
  followViewSig,
  planFollowApply,
  planViewApply,
  readLeaderView,
  registerFollowSurface,
  sameViewAnchor,
  shouldEndFollow,
  stageFollowTarget,
  subscribeFollowSurfaces,
  type FollowView,
} from "../follow";

describe("follow plan", () => {
  const base = { updated_at: 1, withheld: false };
  test("a withheld view blocks; an empty view stays", () => {
    expect(planFollowApply({ ...base, path: "", withheld: true }, { pathname: "/inbox", conversationId: null, anchorMessageId: null })).toEqual({ kind: "blocked" });
    expect(planFollowApply({ ...base, path: "" }, { pathname: "/inbox", conversationId: null, anchorMessageId: null })).toEqual({ kind: "stay", view: null });
  });

  test("a conversation opens when it is not the one on screen, and scrolls to the leader's anchor", () => {
    const view = { ...base, path: "/inbox?s=c1", conversation_id: "c1", anchor: { message_id: "m7", offset: 0.3 } };
    expect(planFollowApply(view, { pathname: "/inbox", conversationId: "c0", anchorMessageId: null })).toEqual({ kind: "session", conversationId: "c1", scrollTo: "m7", view: null });
    expect(planFollowApply(view, { pathname: "/inbox", conversationId: "c1", anchorMessageId: "m2" })).toEqual({ kind: "session", conversationId: "c1", scrollTo: "m7", view: null });
    expect(planFollowApply(view, { pathname: "/inbox", conversationId: "c1", anchorMessageId: "m7" })).toEqual({ kind: "stay", view: null });
  });

  test("a view elsewhere pushes the route only when it differs, ignoring a trailing slash", () => {
    expect(planFollowApply({ ...base, path: "/docs/d1" }, { pathname: "/inbox", conversationId: null, anchorMessageId: null })).toEqual({ kind: "route", path: "/docs/d1", view: null });
    expect(planFollowApply({ ...base, path: "/docs/d1/" }, { pathname: "/docs/d1", conversationId: null, anchorMessageId: null })).toEqual({ kind: "stay", view: null });
  });
});

describe("in-page view: plan", () => {
  const base = { updated_at: 1, withheld: false };
  const here = { pathname: "/docs/d1", conversationId: null, anchorMessageId: null };
  const doc: FollowView = { scroll: { key: "doc", offset: 0.4 } };

  test("a move to another page carries the whole view, since nothing is applied there yet", () => {
    const view = { ...base, path: "/docs/d2", view: doc };
    expect(planFollowApply(view, { ...here, appliedView: doc })).toEqual({ kind: "route", path: "/docs/d2", view: doc });
    const conv = { ...base, path: "/inbox", conversation_id: "c2", view: { panel: "diff", diff: { file: "a.ts", line: 3 } } };
    expect(planFollowApply(conv, { pathname: "/inbox", conversationId: "c1", anchorMessageId: null, appliedView: { panel: "diff" } })).toMatchObject({
      kind: "session",
      view: { panel: "diff", diff: { file: "a.ts", line: 3 } },
    });
  });

  test("on the same page only what changed applies", () => {
    const view = { ...base, path: "/docs/d1", view: { panel: "diff", scroll: { key: "doc", offset: 0.6 } } };
    expect(planFollowApply(view, { ...here, appliedView: { panel: "diff", scroll: { key: "doc", offset: 0.4 } } })).toEqual({
      kind: "stay",
      view: { scroll: { key: "doc", offset: 0.6 } },
    });
    expect(planFollowApply(view, { ...here, appliedView: view.view })).toEqual({ kind: "stay", view: null });
  });

  test("a withheld view applies nothing inside the page either", () => {
    expect(planFollowApply({ ...base, path: "", withheld: true, view: doc }, here)).toEqual({ kind: "blocked" });
  });

  test("planViewApply: changed or never applied parts, with a scroll tolerance", () => {
    const next: FollowView = { panel: "diff", diff: { file: "a.ts", line: 10 }, scroll: { key: "doc", offset: 0.5 } };
    expect(planViewApply(next, null)).toEqual(next);
    expect(planViewApply(next, next)).toBeNull();
    expect(planViewApply(next, { ...next, scroll: { key: "doc", offset: 0.503 } })).toBeNull();
    expect(planViewApply(next, { ...next, scroll: { key: "doc", offset: 0.51 } })).toEqual({ scroll: next.scroll });
    expect(planViewApply(next, { ...next, scroll: { key: "pr", offset: 0.5 } })).toEqual({ scroll: next.scroll });
    expect(planViewApply(next, { ...next, diff: { file: "a.ts", line: 11 } })).toEqual({ diff: next.diff });
    expect(planViewApply(next, { ...next, diff: { file: "a.ts", line: 10, base: "main" } })).toEqual({ diff: next.diff });
    expect(planViewApply(undefined, next)).toBeNull();
  });
});

describe("in-page view: compose and surfaces", () => {
  test("the first surface to name a part holds it; unknown scroll regions and empty parts drop", () => {
    expect(composeLeaderView([])).toBeUndefined();
    expect(composeLeaderView([null, { panel: "" }, undefined])).toBeUndefined();
    expect(
      composeLeaderView([
        { panel: "diff" },
        { panel: "none", diff: { file: "src/a.ts", line: 4.2 } },
        { scroll: { key: "nowhere", offset: 0.3 } },
        { scroll: { key: "doc", offset: 0.12345 } },
        { scroll: { key: "pr", offset: 0.9 } },
      ]),
    ).toEqual({ panel: "diff", diff: { file: "src/a.ts", line: 4 }, scroll: { key: "doc", offset: 0.123 } });
  });

  test("a diff's base can come from another surface than its file; a base alone is no diff", () => {
    expect(composeLeaderView([{ panel: "diff", diff: { file: "", base: "change:3" } }, { diff: { file: "a.ts", line: 9 } }])).toEqual({
      panel: "diff",
      diff: { file: "a.ts", line: 9, base: "change:3" },
    });
    expect(composeLeaderView([{ diff: { file: "a.ts" } }, { diff: { file: "", base: "all" } }])).toEqual({ diff: { file: "a.ts", base: "all" } });
    expect(composeLeaderView([{ panel: "none", diff: { file: "", base: "all" } }])).toEqual({ panel: "none" });
  });

  test("the signature moves exactly when a follower would", () => {
    const v: FollowView = { panel: "diff", diff: { file: "a.ts", line: 3 }, scroll: { key: "doc", offset: 0.25 } };
    expect(followViewSig(v)).toBe(followViewSig({ ...v }));
    expect(followViewSig(v)).not.toBe(followViewSig({ ...v, diff: { file: "a.ts", line: 4 } }));
    expect(followViewSig(undefined)).toBe("");
  });

  test("registered surfaces compose the leader's view and take the parts they own, first taker wins", () => {
    let panel = "none";
    let file: string | null = null;
    const events: string[] = [];
    const unsubEvents = subscribeFollowSurfaces(() => events.push("change"));
    const offPanel = registerFollowSurface({
      read: () => ({ panel }),
      apply: (view) => {
        if (!view.panel) return [];
        panel = view.panel;
        return ["panel"];
      },
    });
    const offDiff = registerFollowSurface({
      read: () => (file ? { diff: { file } } : null),
      apply: (view) => {
        if (!view.diff || view.diff.file === "missing.ts") return [];
        file = view.diff.file;
        return ["diff"];
      },
    });
    const greedy = registerFollowSurface({ apply: () => ["panel", "diff"] });
    try {
      expect(events.length).toBe(3);
      expect(readLeaderView()).toEqual({ panel: "none" });
      expect(applyFollowView({ panel: "diff", diff: { file: "b.ts" }, scroll: { key: "doc", offset: 0.5 } })).toEqual({ scroll: { key: "doc", offset: 0.5 } });
      expect(panel).toBe("diff");
      expect(file).toBe("b.ts");
      expect(readLeaderView()).toEqual({ panel: "diff", diff: { file: "b.ts" } });
      // A file the pane does not hold yet waits: here the greedy one takes it.
      expect(applyFollowView({ diff: { file: "missing.ts" } })).toBeNull();
    } finally {
      greedy();
      offDiff();
      offPanel();
      unsubEvents();
    }
    expect(readLeaderView()).toBeUndefined();
    expect(applyFollowView({ panel: "diff" })).toEqual({ panel: "diff" });
  });
});

describe("anchor", () => {
  const ids = [null, "m1", "m2"];
  test("the top visible item and how much of it is above the container edge", () => {
    const rects = [{ index: 1, top: 80, bottom: 180 }, { index: 2, top: 180, bottom: 300 }];
    expect(anchorFromRects(rects, 1, 100, ids)).toEqual({ messageId: "m1", offset: 0.2 });
    expect(anchorFromRects(rects, 2, 100, ids)).toEqual({ messageId: "m2", offset: 0 });
  });
  test("nothing for a divider, nothing visible, or an index without a rect keeps offset 0", () => {
    expect(anchorFromRects([], 0, 0, ids)).toBeNull();
    expect(anchorFromRects([], -1, 0, ids)).toBeNull();
    expect(anchorFromRects([], 2, 0, ids)).toEqual({ messageId: "m2", offset: 0 });
  });
  test("anchors compare loosely on offset", () => {
    expect(sameViewAnchor({ conversationId: "c", messageId: "m", offset: 0.5 }, { conversationId: "c", messageId: "m", offset: 0.51 })).toBe(true);
    expect(sameViewAnchor({ conversationId: "c", messageId: "m", offset: 0.5 }, { conversationId: "c", messageId: "n", offset: 0.5 })).toBe(false);
    expect(sameViewAnchor(null, null)).toBe(true);
  });
});

describe("ending and labels", () => {
  test("only the follower's own gesture to somewhere other than the applied session ends a follow", () => {
    expect(shouldEndFollow("gesture", "c2", "c1")).toBe(true);
    expect(shouldEndFollow("gesture", "c1", "c1")).toBe(false);
    expect(shouldEndFollow("gesture", null, "c1")).toBe(false);
    expect(shouldEndFollow("follow", "c2", "c1")).toBe(false);
    expect(shouldEndFollow("sync", "c2", "c1")).toBe(false);
    expect(shouldEndFollow("gesture", "c2", null)).toBe(true);
  });
  test("follower labels", () => {
    expect(followersLabel([])).toBe("");
    expect(followersLabel([{ user_id: "b", name: "Bob Stone" }])).toBe("Bob is following you");
    expect(followersLabel([{ user_id: "b", name: "Bob Stone" }, { user_id: "c", name: "Cy" }])).toBe("Bob and Cy are following you");
    expect(followersLabel([{ user_id: "b", name: "Bob" }, { user_id: "c", name: "Cy" }, { user_id: "d", name: "Dan" }])).toBe("3 following you");
  });
});

describe("call stage", () => {
  const base = {
    view: "speaker",
    pinned: null as string | null,
    speaker: "bob",
    leader: "cy",
    self: "ann",
    inCall: (id: string) => ["ann", "bob", "cy", "agent:x"].includes(id),
    isPerson: (id: string) => !id.startsWith("agent:"),
  };
  test("a follower on the call moves with the face the speaker view shows, a pin first", () => {
    expect(stageFollowTarget(base)).toBe("bob");
    expect(stageFollowTarget({ ...base, pinned: "cy", speaker: "bob" })).toBeNull();
    expect(stageFollowTarget({ ...base, pinned: "bob", speaker: "cy" })).toBe("bob");
  });
  test("leaves the follow alone otherwise", () => {
    expect(stageFollowTarget({ ...base, view: "grid" })).toBeNull();
    expect(stageFollowTarget({ ...base, leader: null })).toBeNull();
    expect(stageFollowTarget({ ...base, leader: "dan" })).toBeNull();
    expect(stageFollowTarget({ ...base, speaker: "ann" })).toBeNull();
    expect(stageFollowTarget({ ...base, speaker: "agent:x" })).toBeNull();
    expect(stageFollowTarget({ ...base, speaker: null })).toBeNull();
  });
});
