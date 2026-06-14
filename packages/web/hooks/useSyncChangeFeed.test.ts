import { describe, expect, it } from "bun:test";
import { planFeedApply, type FeedChange } from "./useSyncChangeFeed";

const c = (entity_type: string, entity_id: string, op: "upsert" | "delete" = "upsert"): FeedChange =>
  ({ entity_type, entity_id, op });

describe("planFeedApply", () => {
  it("routes each entity_type to its store collection", () => {
    const plan = planFeedApply([
      c("conversations", "k1"),
      c("tasks", "t1"),
      c("docs", "d1"),
      c("plans", "p1"),
    ]);
    expect(plan.sessions.upsertIds).toEqual(["k1"]);
    expect(plan.tasks.upsertIds).toEqual(["t1"]);
    expect(plan.docs.upsertIds).toEqual(["d1"]);
    expect(plan.plans.upsertIds).toEqual(["p1"]);
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
