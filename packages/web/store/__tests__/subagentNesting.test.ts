import { describe, expect, it } from "bun:test";
import type { InboxSession } from "../inboxStore";
import { sessionStructuralSig } from "../inboxStore";
import { placeSections } from "./placeTestHarness";

const now = Date.now();
const row = (id: string, over: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: id,
  title: id,
  agent_type: "codex",
  agent_status: "working",
  is_idle: false,
  message_count: 5,
  updated_at: now,
  ...over,
});
const parent = row("parent");
const child = row("child", { parent_conversation_id: "parent", is_subagent: true, inbox_dismissed_at: now });
const ids = (rows: InboxSession[]) => rows.map(row => row._id);
const place = (rows: InboxSession[]) => placeSections(Object.fromEntries(rows.map(row => [row._id, row])), new Set(), undefined, { now });

describe("linked subagent nesting", () => {
  it("nests an automatically dismissed child without adding an inbox card or count", () => {
    const placed = place([parent, child]);
    expect(ids(placed.subsByParent.get("parent") ?? [])).toEqual(["child"]);
    expect(ids(placed.working)).toEqual(["parent"]);
    expect(placed.tally.shown.working).toBe(1);
    expect(placed.dismissed).toEqual([]);
  });

  it("supports legacy parent-linked children without the subagent flag", () => {
    const placed = place([parent, { ...child, is_subagent: undefined }]);
    expect(ids(placed.subsByParent.get("parent") ?? [])).toEqual(["child"]);
  });

  it("honors explicit stash and kill on a child", () => {
    for (const stamp of [{ inbox_stashed_at: now }, { inbox_killed_at: now }]) {
      expect(sessionStructuralSig({ ...child, ...stamp })).not.toBe(sessionStructuralSig(child));
      const placed = place([parent, { ...child, ...stamp }]);
      expect(placed.subsByParent.get("parent") ?? []).toEqual([]);
      expect(ids(placed.working)).toEqual(["parent"]);
    }
  });

  it("never exposes children under an absent or hidden parent", () => {
    for (const rows of [[child], [child, { ...parent, inbox_dismissed_at: now }], [child, { ...parent, inbox_stashed_at: now }]]) {
      const placed = place(rows);
      expect(placed.subsByParent.size).toBe(0);
      expect(placed.working).toEqual([]);
      expect(placed.sorted).toEqual([]);
    }
  });

  it("keeps a dismissed plan handoff dismissed", () => {
    const placed = place([parent, { ...child, is_subagent: false, parent_message_uuid: "plan-handoff" }]);
    expect(placed.subsByParent.size).toBe(0);
    expect(ids(placed.dismissed)).toEqual(["child"]);
  });

});
