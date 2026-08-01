import { describe, expect, it } from "bun:test";
import { BYIDS_CHUNK, chunkIds, planFeedApply, type FeedChange } from "./useSyncChangeFeed";

const c = (entity_type: string, entity_id: string, op: "upsert" | "delete" = "upsert"): FeedChange =>
  ({ entity_type, entity_id, op });

describe("planFeedApply", () => {
  it("routes each entity_type to its store collection", () => {
    const plan = planFeedApply([
      c("conversations", "k1"),
      c("tasks", "t1"),
      c("docs", "d1"),
      c("plans", "p1"),
      c("projects", "pj1"),
      c("strategies", "s1"),
      c("steering_items", "si1"),
    ]);
    expect(plan.sessions.upsertIds).toEqual(["k1"]);
    expect(plan.tasks.upsertIds).toEqual(["t1"]);
    expect(plan.docs.upsertIds).toEqual(["d1"]);
    expect(plan.plans.upsertIds).toEqual(["p1"]);
    expect(plan.projects.upsertIds).toEqual(["pj1"]);
    expect(plan.strategies.upsertIds).toEqual(["s1"]);
    expect(plan.steeringItems.upsertIds).toEqual(["si1"]);
  });

  it("routes steering deletes for prune", () => {
    const plan = planFeedApply([c("steering_items", "si1", "delete"), c("strategies", "s1", "delete")]);
    expect(plan.steeringItems.deleteIds).toEqual(["si1"]);
    expect(plan.strategies.deleteIds).toEqual(["s1"]);
  });

  it("splits upserts from deletes", () => {
    const plan = planFeedApply([c("conversations", "a"), c("conversations", "b", "delete")]);
    expect(plan.sessions.upsertIds).toEqual(["a"]);
    expect(plan.sessions.deleteIds).toEqual(["b"]);
  });

  it("collapses repeated events for one id, last op wins", () => {
    // changed, then deleted within the same page → net delete.
    const del = planFeedApply([c("tasks", "x"), c("tasks", "x", "delete")]);
    expect(del.tasks.upsertIds).toEqual([]);
    expect(del.tasks.deleteIds).toEqual(["x"]);
    // deleted, then re-created (id reuse won't happen, but op ordering must hold).
    const up = planFeedApply([c("tasks", "y", "delete"), c("tasks", "y")]);
    expect(up.tasks.upsertIds).toEqual(["y"]);
    expect(up.tasks.deleteIds).toEqual([]);
  });

  it("ignores unknown entity types", () => {
    const plan = planFeedApply([c("messages", "m1"), c("conversations", "k1")]);
    expect(plan.sessions.upsertIds).toEqual(["k1"]);
    const total = Object.values(plan).reduce((n, g) => n + g.upsertIds.length + g.deleteIds.length, 0);
    expect(total).toBe(1);
  });

  it("handles an empty page", () => {
    const plan = planFeedApply([]);
    for (const g of Object.values(plan)) {
      expect(g.upsertIds).toEqual([]);
      expect(g.deleteIds).toEqual([]);
    }
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
