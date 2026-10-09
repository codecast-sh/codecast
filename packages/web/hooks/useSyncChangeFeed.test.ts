import { describe, expect, it } from "bun:test";
import { BYIDS_CHUNK, admitLogSessions, chunkIds, planFeedApply, type FeedChange } from "./useSyncChangeFeed";

const c = (entity_type: string, entity_id: string): FeedChange => ({ entity_type, entity_id });

describe("planFeedApply", () => {
  it("routes each entity_type to its store collection", () => {
    const plan = planFeedApply([
      c("conversations", "k1"),
      c("tasks", "t1"),
      c("docs", "d1"),
      c("plans", "p1"),
      c("projects", "pj1"),
    ]);
    expect(plan.sessions).toEqual(["k1"]);
    expect(plan.tasks).toEqual(["t1"]);
    expect(plan.docs).toEqual(["d1"]);
    expect(plan.plans).toEqual(["p1"]);
    expect(plan.projects).toEqual(["pj1"]);
  });

  it("dedupes repeated events for one id — the op never matters, deletion truth is authorized absence", () => {
    const plan = planFeedApply([c("tasks", "x"), c("tasks", "x"), c("tasks", "y")]);
    expect(plan.tasks).toEqual(["x", "y"]);
  });

  it("ignores unknown entity types", () => {
    const plan = planFeedApply([c("messages", "m1"), c("conversations", "k1")]);
    expect(plan.sessions).toEqual(["k1"]);
    const total = Object.values(plan).reduce((n, ids) => n + ids.length, 0);
    expect(total).toBe(1);
  });

  it("handles an empty page", () => {
    const plan = planFeedApply([]);
    for (const ids of Object.values(plan)) expect(ids).toEqual([]);
  });
});

describe("chunkIds", () => {
  it("splits past the server-side 300-id byIds cap so no id goes un-fetched", () => {
    // A feed page can carry up to 1000 upserts for one collection; every
    // webGetByIds slices its input at 300. An un-fetched id would be treated
    // as deleted and PRUNED — chunking is what prevents that.
    const ids = Array.from({ length: 301 }, (_, i) => `id${i}`);
    const chunks = chunkIds(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(BYIDS_CHUNK);
    expect(chunks[1]).toEqual(["id300"]);
    expect(chunks.flat()).toEqual(ids);
  });

  it("keeps a small page in one chunk and an empty page in none", () => {
    expect(chunkIds(["a", "b"])).toEqual([["a", "b"]]);
    expect(chunkIds([])).toEqual([]);
  });
});

describe("admitLogSessions", () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  const old = { _id: "old", updated_at: NOW - 60 * DAY, inbox_dismissed_at: NOW - 40 * DAY };
  const recent = { _id: "recent", updated_at: NOW - 2 * DAY };
  const none = () => false;

  it("leaves out a session the replica does not hold and hydration would drop", () => {
    expect(admitLogSessions([old, recent], none, new Set(), NOW)).toEqual([recent]);
  });

  it("applies a change to an old session the replica holds", () => {
    expect(admitLogSessions([old], (id) => id === "old", new Set(), NOW)).toEqual([old]);
  });

  it("admits an old session the server lists in the live inbox", () => {
    expect(admitLogSessions([old], none, new Set(["old"]), NOW)).toEqual([old]);
  });

  it("admits a row with no stamps: it cannot be judged old", () => {
    expect(admitLogSessions([{ _id: "bare" }], none, new Set(), NOW)).toEqual([{ _id: "bare" }]);
  });

  it("admits an old session that is pinned or was dismissed inside the window", () => {
    const pinned = { ...old, _id: "pinned", is_pinned: true };
    const justDismissed = { ...old, _id: "dismissed", inbox_dismissed_at: NOW - DAY };
    expect(admitLogSessions([pinned, justDismissed], none, new Set(), NOW)).toEqual([pinned, justDismissed]);
  });
});
