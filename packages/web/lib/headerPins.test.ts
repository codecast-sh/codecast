import { describe, expect, test } from "bun:test";
import { defaultPinOf, movePin, resolveHeaderPins } from "./headerPins";
import type { AnchorRow } from "../hooks/useSyncAnchors";

// S30: with no pins chosen, the header shows the person's global Executive
// Assistant on every workspace, named, with its role and reach as the subtitle.
const row = (o: Partial<AnchorRow>): AnchorRow => ({ _id: "a", scope_type: "team", team_id: "t1", bot_user_id: "b", host_user_id: "h", name: "x", bot_name: "x", bot_avatar: null, team_name: "Union", ...o } as AnchorRow);
const head = row({ _id: "head", is_root: true, conversation_id: "c-head", role: { _id: "r10", short_id: "or-10", name: "Head of People", handle: "head-of-people", avatar: null, status: "active" } as any });
const assistant = (status: string) => row({ _id: "ea", scope_type: "user", team_id: null, team_name: null, is_root: true, conversation_id: "c-ea", role: { _id: "r44", short_id: "or-44", name: "Executive Assistant", handle: "executive-assistant", avatar: "bear", status, given_name: "Ada", assistant: { reach: "global" } } as any });

describe("resolveHeaderPins", () => {
  test("the default pin is the global Executive Assistant, in a team workspace too", () => {
    const [pin, ...rest] = resolveHeaderPins(null, [head, assistant("active")], {}, "t1");
    expect(rest).toEqual([]);
    expect(pin).toMatchObject({ key: "anchor:ea", conversationId: "c-ea", name: "Ada", subtitle: "Executive Assistant, global", isDefault: true });
  });

  test("with none standing the header falls back to the workspace's agent", () => {
    for (const anchors of [[head], [head, assistant("retired")]]) {
      expect(resolveHeaderPins(null, anchors, {}, "t1").map((p) => [p.key, p.subtitle])).toEqual([["anchor:head", "Head of People"]]);
    }
  });

  // An emptied list draws no face, but the panel still has the assistant to
  // open on: it offered "Hire your Executive Assistant" to a person who had one.
  test("an emptied list resolves nothing, and the default still names the assistant", () => {
    expect(resolveHeaderPins([], [head, assistant("active")], {}, "t1")).toEqual([]);
    expect(defaultPinOf([head, assistant("active")], "t1")?.key).toBe("anchor:ea");
  });
});

describe("movePin", () => {
  const a = { kind: "role", id: "a" } as const;
  const b = { kind: "session", id: "b" } as const;
  const c = { kind: "role", id: "c" } as const;
  const hidden = { kind: "session", id: "gone" } as const;

  test("moves a pin before another, or to the end", () => {
    expect(movePin([a, b, c], c, a)).toEqual([c, a, b]);
    expect(movePin([a, b, c], a, c)).toEqual([b, a, c]);
    expect(movePin([a, b, c], a, null)).toEqual([b, c, a]);
  });

  test("dropping a pin before itself changes nothing", () => {
    const list = [a, b, c];
    expect(movePin(list, b, b)).toBe(list);
  });

  // A pin the viewer cannot draw (another workspace's session) keeps its
  // place relative to the others instead of being dropped or reshuffled.
  test("pins the header cannot draw keep their places", () => {
    expect(movePin([a, hidden, b, c], c, b)).toEqual([a, hidden, c, b]);
    expect(movePin([a, hidden, b], a, null)).toEqual([hidden, b, a]);
  });

  test("a kind and an id together name a pin", () => {
    const sessionA = { kind: "session", id: "a" } as const;
    expect(movePin([a, sessionA, b], b, sessionA)).toEqual([a, b, sessionA]);
  });
});
