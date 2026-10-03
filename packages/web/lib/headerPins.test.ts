import { describe, expect, test } from "bun:test";
import { resolveHeaderPins } from "./headerPins";
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
});
