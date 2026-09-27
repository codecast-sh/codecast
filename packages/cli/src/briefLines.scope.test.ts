import { describe, expect, test } from "bun:test";
import { briefPlanLines, briefScopeLine } from "./briefLines";

describe("brief scope and plans", () => {
  test("a project's plans are named by the project; loose plans are capped with a count", () => {
    const plans = [
      ...Array.from({ length: 200 }, (_, i) => ({ short_id: `pl-${i}`, title: `In ${i}`, project_id: "p1" })),
      ...Array.from({ length: 7 }, (_, i) => ({ short_id: `pl-x${i}`, title: `Loose ${i}` })),
    ];
    expect(briefScopeLine({ projects: [{ id: "p1", title: "Infra" }], plans })).toBe("project Infra, plan pl-x0 Loose 0, plan pl-x1 Loose 1, plan pl-x2 Loose 2, plan pl-x3 Loose 3, plan pl-x4 Loose 4, and 2 more plans");
  });
  test("only active plans with tasks are listed, a few at most", () => {
    const plan = (i: number, over: any = {}) => ({ short_id: `pl-${i}`, title: `P${i}`, status: "active", updated_at: i, progress: { total: 3, done: 1, in_progress: 1 }, ...over });
    const lines = briefPlanLines([...Array.from({ length: 10 }, (_, i) => plan(i)), plan(99, { progress: { total: 0, done: 0, in_progress: 0 } }), plan(98, { status: "draft" })]);
    expect(lines).toHaveLength(9);
    expect(lines[0]).toContain("pl-9");
    expect(lines.join("\n")).not.toContain("pl-99");
    expect(lines.join("\n")).not.toContain("pl-98");
  });
});
