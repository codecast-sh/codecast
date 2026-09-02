import { describe, expect, it } from "bun:test";
import type { Patch } from "mutative";
import {
  createFollowerInbox,
  extractReplicationUpdates,
  snapshotEntries,
} from "./replication";

const isReplicated = (k: string) => k !== "localOnly" && k !== "pending";
const isCollection = (k: string) => k === "sessions" || k === "tasks";

const p = (op: "add" | "replace" | "remove", path: (string | number)[], value?: any): Patch =>
  ({ op, path, value }) as Patch;

describe("extractReplicationUpdates", () => {
  const state = {
    sessions: {
      a: { _id: "a", title: "A", n: 1 },
      b: { _id: "b", title: "B" },
    },
    tasks: { t1: { _id: "t1" } },
    counter: 7,
    localOnly: { x: 1 },
    pending: { "sessions:a:title": { type: "field" } },
  };

  it("collects whole rows for touched collection ids, from state", () => {
    const updates = extractReplicationUpdates(
      [p("replace", ["sessions", "a", "n"], 1), p("replace", ["sessions", "a", "title"], "A")],
      state, isReplicated, isCollection,
    );
    expect(updates).toEqual([{ key: "sessions", upserts: [state.sessions.a] }]);
  });

  it("emits removes for record-level remove patches", () => {
    const updates = extractReplicationUpdates(
      [p("remove", ["sessions", "gone"])],
      state, isReplicated, isCollection,
    );
    expect(updates).toEqual([{ key: "sessions", removes: ["gone"] }]);
  });

  it("a row written then removed in one batch lands only in removes", () => {
    const updates = extractReplicationUpdates(
      [p("add", ["sessions", "tmp"], { _id: "tmp" }), p("remove", ["sessions", "tmp"])],
      state, isReplicated, isCollection,
    );
    expect(updates).toEqual([{ key: "sessions", removes: ["tmp"] }]);
  });

  it("whole-collection replace sends every row as an upsert overlay", () => {
    const updates = extractReplicationUpdates(
      [p("replace", ["sessions"], {})],
      state, isReplicated, isCollection,
    );
    expect(updates).toEqual([
      { key: "sessions", upserts: [state.sessions.a, state.sessions.b] },
    ]);
  });

  it("whole-collection replace with a shadow ships only identity-changed rows and real removals", () => {
    const prev = { a: state.sessions.a, b: { _id: "b", title: "old B" }, gone: { _id: "gone" } };
    const updates = extractReplicationUpdates(
      [p("replace", ["sessions"], {})],
      state, isReplicated, isCollection,
      { shadowOf: (k) => (k === "sessions" ? prev : undefined) },
    );
    // `a` kept its identity (unchanged), `b` is a new object, `gone` vanished.
    expect(updates).toEqual([{ key: "sessions", upserts: [state.sessions.b], removes: ["gone"] }]);
  });

  it("whole-collection replace with an identical shadow is a no-op", () => {
    const updates = extractReplicationUpdates(
      [p("replace", ["sessions"], {})],
      state, isReplicated, isCollection,
      { shadowOf: () => state.sessions },
    );
    expect(updates).toEqual([]);
  });

  it("non-collection keys carry the whole value, with hasValue", () => {
    const updates = extractReplicationUpdates(
      [p("replace", ["counter"], 7)],
      state, isReplicated, isCollection,
    );
    expect(updates).toEqual([{ key: "counter", value: 7, hasValue: true }]);
  });

  it("skips non-replicated keys entirely", () => {
    const updates = extractReplicationUpdates(
      [
        p("replace", ["localOnly", "x"], 2),
        p("replace", ["pending"], {}),
        p("replace", ["tasks", "t1", "status"], "done"),
      ],
      state, isReplicated, isCollection,
    );
    expect(updates).toEqual([{ key: "tasks", upserts: [state.tasks.t1] }]);
  });

  it("deep nested patches resolve to the whole row", () => {
    const updates = extractReplicationUpdates(
      [p("add", ["sessions", "b", "list", 0], "item")],
      state, isReplicated, isCollection,
    );
    expect(updates).toEqual([{ key: "sessions", upserts: [state.sessions.b] }]);
  });
});

describe("snapshotEntries", () => {
  it("captures defined replicated keys only", () => {
    expect(snapshotEntries({ a: 1, b: undefined, c: {} }, ["a", "b", "c", "d"]))
      .toEqual({ a: 1, c: {} });
  });
});

describe("createFollowerInbox", () => {
  type Msg = { hostId: string; seq: number; tag: string };
  const m = (hostId: string, seq: number, tag = ""): Msg => ({ hostId, seq, tag });

  it("buffers before the snapshot and replays the contiguous tail", () => {
    const inbox = createFollowerInbox<Msg>();
    expect(inbox.onUpdate(m("h1", 4, "early"))).toEqual({ action: "apply", messages: [] });
    expect(inbox.onUpdate(m("h1", 5, "later"))).toEqual({ action: "apply", messages: [] });
    const res = inbox.onSnapshot({ hostId: "h1", seq: 3 });
    expect(res).toEqual({ action: "apply", messages: [m("h1", 4, "early"), m("h1", 5, "later")] });
    expect(inbox.synced()).toBe(true);
    expect(inbox.lastSeq()).toBe(5);
  });

  it("drops buffered messages at or below the snapshot seq", () => {
    const inbox = createFollowerInbox<Msg>();
    inbox.onUpdate(m("h1", 2));
    inbox.onUpdate(m("h1", 3));
    expect(inbox.onSnapshot({ hostId: "h1", seq: 3 })).toEqual({ action: "apply", messages: [] });
    expect(inbox.lastSeq()).toBe(3);
  });

  it("applies contiguous live updates and ignores duplicates", () => {
    const inbox = createFollowerInbox<Msg>();
    inbox.onSnapshot({ hostId: "h1", seq: 0 });
    expect(inbox.onUpdate(m("h1", 1))).toEqual({ action: "apply", messages: [m("h1", 1)] });
    expect(inbox.onUpdate(m("h1", 1))).toEqual({ action: "apply", messages: [] });
    expect(inbox.onUpdate(m("h1", 2))).toEqual({ action: "apply", messages: [m("h1", 2)] });
  });

  it("a gap forces resync and resets to buffering", () => {
    const inbox = createFollowerInbox<Msg>();
    inbox.onSnapshot({ hostId: "h1", seq: 0 });
    inbox.onUpdate(m("h1", 1));
    expect(inbox.onUpdate(m("h1", 3))).toEqual({ action: "resync" });
    expect(inbox.synced()).toBe(false);
    // Buffers again until the next snapshot.
    expect(inbox.onUpdate(m("h1", 4))).toEqual({ action: "apply", messages: [] });
    expect(inbox.onSnapshot({ hostId: "h1", seq: 3 })).toEqual({ action: "apply", messages: [m("h1", 4)] });
  });

  it("a new hostId forces resync", () => {
    const inbox = createFollowerInbox<Msg>();
    inbox.onSnapshot({ hostId: "h1", seq: 5 });
    expect(inbox.onUpdate(m("h2", 1))).toEqual({ action: "resync" });
  });

  it("a hole in the buffered tail forces resync at snapshot time", () => {
    const inbox = createFollowerInbox<Msg>();
    inbox.onUpdate(m("h1", 4));
    inbox.onUpdate(m("h1", 6));
    expect(inbox.onSnapshot({ hostId: "h1", seq: 3 })).toEqual({ action: "resync" });
    expect(inbox.synced()).toBe(false);
  });
});
