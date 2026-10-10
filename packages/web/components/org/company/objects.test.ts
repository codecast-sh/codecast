// Run: bun test components/org/company/objects.test.ts
import { describe, expect, it } from "bun:test";
import { findGoal } from "./objects";

describe("finding a goal by any ref a link may carry", () => {
  it("a goal opened by its stub key follows the server row that supersedes it", () => {
    const stub = { _id: "instub-1", client_key: "instub-1", title: "Grow" } as any;
    const real = { _id: "goal0000000000000000000000000000", client_key: "instub-1", short_id: "in-3", title: "Grow" } as any;
    expect(findGoal([stub], "instub-1")).toBe(stub);
    expect(findGoal([real], "instub-1")).toBe(real);
    expect(findGoal([real], "IN-3")).toBe(real);
    expect(findGoal([real], real._id)).toBe(real);
    expect(findGoal([real], "in-4")).toBeUndefined();
  });
});
