import { describe, expect, test } from "bun:test";
import { anchorFromRects, followersLabel, planFollowApply, sameViewAnchor, shouldEndFollow } from "../follow";

describe("follow plan", () => {
  const base = { updated_at: 1, withheld: false };
  test("a withheld view blocks; an empty view stays", () => {
    expect(planFollowApply({ ...base, path: "", withheld: true }, { pathname: "/inbox", conversationId: null, anchorMessageId: null })).toEqual({ kind: "blocked" });
    expect(planFollowApply({ ...base, path: "" }, { pathname: "/inbox", conversationId: null, anchorMessageId: null })).toEqual({ kind: "stay" });
  });

  test("a conversation opens when it is not the one on screen, and scrolls to the leader's anchor", () => {
    const view = { ...base, path: "/inbox?s=c1", conversation_id: "c1", anchor: { message_id: "m7", offset: 0.3 } };
    expect(planFollowApply(view, { pathname: "/inbox", conversationId: "c0", anchorMessageId: null })).toEqual({ kind: "session", conversationId: "c1", scrollTo: "m7" });
    expect(planFollowApply(view, { pathname: "/inbox", conversationId: "c1", anchorMessageId: "m2" })).toEqual({ kind: "session", conversationId: "c1", scrollTo: "m7" });
    expect(planFollowApply(view, { pathname: "/inbox", conversationId: "c1", anchorMessageId: "m7" })).toEqual({ kind: "stay" });
  });

  test("a view elsewhere pushes the route only when it differs, ignoring a trailing slash", () => {
    expect(planFollowApply({ ...base, path: "/docs/d1" }, { pathname: "/inbox", conversationId: null, anchorMessageId: null })).toEqual({ kind: "route", path: "/docs/d1" });
    expect(planFollowApply({ ...base, path: "/docs/d1/" }, { pathname: "/docs/d1", conversationId: null, anchorMessageId: null })).toEqual({ kind: "stay" });
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
