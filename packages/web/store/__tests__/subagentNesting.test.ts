import { describe, expect, it } from "bun:test";
import type { InboxSession } from "../inboxStore";
import { sessionStructuralSig } from "../inboxStore";
import { hiddenBucketTree } from "../hiddenBucketTree";
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

  it("honors explicit stash, kill and snooze on a child", () => {
    for (const stamp of [{ inbox_stashed_at: now }, { inbox_killed_at: now }, { inbox_snoozed_until: now + 60_000 }]) {
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

  it("keeps a snoozed parent and its child out of active sections until wake", () => {
    const until = now + 60_000;
    const rows = [{ ...parent, inbox_snoozed_until: until }, { ...child, inbox_snoozed_until: until }];
    const placed = place(rows);
    expect(ids(placed.snoozed)).toEqual(["parent"]);
    expect(placed.working).toEqual([]);
    expect(placed.subsByParent.size).toBe(0);
    const awake = placeSections(Object.fromEntries(rows.map(row => [row._id, row])), new Set(), undefined, { now: until + 60_000 });
    expect(ids(awake.subsByParent.get("parent") ?? [])).toEqual(["child"]);
    expect(awake.snoozed).toEqual([]);
  });
});

describe("set aside bucket rows", () => {
  const stashed = (id: string, parentId?: string) =>
    row(id, { inbox_stashed_at: now, ...(parentId ? { parent_conversation_id: parentId, is_subagent: true } : {}) });

  it("draws a stashed child whose parent is outside the bucket as its own card", () => {
    const { topLevel, subsByTop } = hiddenBucketTree([stashed("a"), stashed("orphan", "live-lead")]);
    expect(ids(topLevel)).toEqual(["a", "orphan"]);
    expect(subsByTop.size).toBe(0);
  });

  it("nests every descendant under its outermost ancestor in the bucket", () => {
    const { topLevel, subsByTop } = hiddenBucketTree([stashed("root"), stashed("kid", "root"), stashed("grandkid", "kid")]);
    expect(ids(topLevel)).toEqual(["root"]);
    expect(ids(subsByTop.get("root") ?? []).sort()).toEqual(["grandkid", "kid"]);
  });

  it("draws every row exactly once, so the header count matches", () => {
    const items = [stashed("root"), stashed("kid", "root"), stashed("grandkid", "kid"), stashed("orphan", "elsewhere"), stashed("x", "y"), stashed("y", "x")];
    const { topLevel, subsByTop } = hiddenBucketTree(items);
    const drawn = [...topLevel, ...topLevel.flatMap((top) => subsByTop.get(top._id) ?? [])];
    expect(ids(drawn).sort()).toEqual(ids(items).sort());
  });
});
